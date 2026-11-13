/* Shared by index.html (explorer) and explore.html (checkpoint graphs):
   formatters, tooltip, GOES pixel geometry and data preparation. */

const HOUR_MS = 3600e3;
const NIGHT_START = 19; // solar hour. The cloud flag drops out here, matching sunset in July and August.
const NIGHT_END = 5;
const NIGHT_BAND_MAX_DAYS = 14; // shading more days than this turns into stripes
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const fmtDay = d3.utcFormat("%b %-d");
const fmtHour = d3.utcFormat("%H:00");
const fmtInt = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtGW = v => (v >= 100 ? fmtInt(v) : d3.format(".1f")(v));
const hourLabel = h => `${String(h).padStart(2, "0")}:00`;
const isNight = h => h >= NIGHT_START || h < NIGHT_END;
const compass = deg => COMPASS[Math.round(deg / 45) % 8];

let meta, series, runs, seriesById, totalHours, pixelData, states;

const tooltip = (() => {
  const el = document.getElementById("tooltip");

  function row(value, label, color) {
    const div = document.createElement("div");
    div.className = "tip-row";
    if (color) {
      const key = document.createElement("span");
      key.className = "tip-key";
      key.style.background = color;
      div.append(key);
    }
    const b = document.createElement("b");
    b.textContent = value;
    const span = document.createElement("span");
    span.className = "tip-label";
    span.textContent = label;
    div.append(b, span);
    return div;
  }

  return {
    show(x, y, title, rows) {
      const head = document.createElement("div");
      head.className = "tip-title";
      head.textContent = title;
      el.replaceChildren(head, ...rows.map(r => row(...r)));
      el.hidden = false;
      const box = el.getBoundingClientRect();
      const left = x + 14 + box.width > window.innerWidth - 8 ? x - box.width - 14 : x + 14;
      const top = Math.min(Math.max(8, y - box.height - 10), window.innerHeight - box.height - 8);
      el.style.left = `${Math.max(8, left)}px`;
      el.style.top = `${top}px`;
    },
    hide() { el.hidden = true; },
  };
})();

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hourDate(i) {
  return new Date(+new Date(meta.t0) + i * HOUR_MS);
}

/* Pixels for graphs 1 to 3. pixels.json stores each position once, then per
   solar hour a flat list of [pixel index, scans that saw it, MW]. MW > 0 is
   reported power, MW < 0 a gap-filled estimate, 0 no value. */
/* GOES-18 fixed grid (Product User Guide vol. 3, sec. 5.1.2.8). Fire pixels sit on a
   56 microradian scan-angle grid, so each one's ground footprint is the four corners
   half a step either side. Over the West they come out about 2.2 by 3.4 km and tilted. */
const GOES = { a: 6378137, b: 6356752.31414, H: 6378137 + 35786023, lon0: -137 * Math.PI / 180, step: 56e-6 };

function geoToScan(lon, lat) {
  const { a, b, H, lon0 } = GOES;
  const phi = lat * Math.PI / 180;
  const lam = lon * Math.PI / 180;
  const phic = Math.atan((b * b) / (a * a) * Math.tan(phi));
  const rc = b / Math.sqrt(1 - ((a * a - b * b) / (a * a)) * Math.cos(phic) ** 2);
  const sx = H - rc * Math.cos(phic) * Math.cos(lam - lon0);
  const sy = -rc * Math.cos(phic) * Math.sin(lam - lon0);
  const sz = rc * Math.sin(phic);
  return [Math.asin(-sy / Math.hypot(sx, sy, sz)), Math.atan(sz / sx)];
}

function scanToGeo(x, y) {
  const { a, b, H, lon0 } = GOES;
  const qa = Math.sin(x) ** 2 + Math.cos(x) ** 2 * (Math.cos(y) ** 2 + (a / b) ** 2 * Math.sin(y) ** 2);
  const qb = -2 * H * Math.cos(x) * Math.cos(y);
  const qc = H * H - a * a;
  const rs = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  const sx = rs * Math.cos(x) * Math.cos(y);
  const sy = -rs * Math.sin(x);
  const sz = rs * Math.cos(x) * Math.sin(y);
  const lat = Math.atan((a / b) ** 2 * sz / Math.hypot(H - sx, sy));
  const lon = lon0 - Math.atan(sy / (H - sx));
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

function footprint(lon, lat) {
  const [x, y] = geoToScan(lon, lat);
  const h = GOES.step / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([dx, dy]) => scanToGeo(x + dx, y + dy));
}

function preparePixels(raw) {
  const n = raw.pixels.length / 3;
  const pos = new Array(n);
  for (let i = 0; i < n; i++) {
    const lat = raw.pixels[i * 3] / 1e4;
    const lon = raw.pixels[i * 3 + 1] / 1e4;
    pos[i] = { lat, lon, fire: raw.pixels[i * 3 + 2], corners: footprint(lon, lat) };
  }
  const fireIndex = new Map(raw.fires.map((id, i) => [id, i]));
  return { pos, hours: raw.hours, fireIndex };
}

/* d3 wants polygon rings clockwise; GeoJSON from shapely is the other way. */
function rewind(geom) {
  const fix = poly => (d3.geoArea({ type: "Polygon", coordinates: poly }) > 2 * Math.PI ? poly.map(r => r.slice().reverse()) : poly);
  return geom.type === "Polygon"
    ? { type: "Polygon", coordinates: fix(geom.coordinates) }
    : { type: "MultiPolygon", coordinates: geom.coordinates.map(fix) };
}

function pearson(xs, ys) {
  const mx = d3.mean(xs), my = d3.mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function nightSpans(a, b) {
  const spans = [];
  for (let day = Math.floor(a / 24) - 1; day <= Math.ceil(b / 24); day++) {
    spans.push([day * 24 + NIGHT_START, (day + 1) * 24 + NIGHT_END]);
  }
  return spans;
}

function hourProfile(rows) {
  const bins = d3.range(24).map(h => ({ h, withFrp: 0, noFrp: 0, count: 0 }));
  for (const d of rows) {
    const bin = bins[d.hod];
    bin.withFrp += d.withFrp;
    bin.noFrp += d.noFrp;
    bin.count += 1;
  }
  for (const bin of bins) {
    bin.withFrp = bin.count ? bin.withFrp / bin.count : 0;
    bin.noFrp = bin.count ? bin.noFrp / bin.count : 0;
    bin.total = bin.withFrp + bin.noFrp;
    bin.share = bin.total ? bin.noFrp / bin.total : 0;
  }
  return bins;
}

function roundedTopBar(x, y, w, h, r) {
  if (h <= 0) return `M${x},${y}h${w}v0h${-w}Z`;
  const c = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + c}Q${x},${y} ${x + c},${y}H${x + w - c}Q${x + w},${y} ${x + w},${y + c}V${y + h}Z`;
}

function busiestWindow(hours, span = 72) {
  const values = hours.map(d => d.filled);
  let sum = d3.sum(values.slice(0, span));
  let best = sum;
  let bestStart = 0;
  for (let i = span; i < values.length; i++) {
    sum += values[i] - values[i - span];
    if (sum > best) {
      best = sum;
      bestStart = i - span + 1;
    }
  }
  return [bestStart, bestStart + span];
}

function prepareData(raw) {
  meta = raw.meta;
  totalHours = meta.hours;
  series = raw.series.map(s => {
    const hours = d3.range(totalHours).map(i => ({
      i, date: hourDate(i), hod: i % 24, withFrp: 0, noFrp: 0, reported: 0, filled: 0,
    }));
    for (const [i, withFrp, noFrp, reported, filled] of s.rows) {
      if (i < totalHours) Object.assign(hours[i], { withFrp, noFrp, reported, filled });
    }
    return { ...s, hours };
  });
  seriesById = new Map(series.map(s => [s.id, s]));

  runs = raw.spread.map(r => {
    const last = r.pts[r.pts.length - 1];
    const perimeterGeo = rewind(r.perimeter);
    const perimeterPoints = (perimeterGeo.type === "Polygon" ? [perimeterGeo.coordinates] : perimeterGeo.coordinates).flat(2);
    return { ...r, perimeterGeo, perimeterPoints, lastHour: last[0], farthest: last[1], fastest: fastestRun(r.pts) };
  }).sort((a, b) => d3.descending(a.fastest.km, b.fastest.km));
  for (const r of d3.sort(runs, r => -r.farthest).slice(0, 2)) r.alwaysLabel = true;
}

/* Largest gain within a 6-hour span. Merge steps are taken out first, because
   linking up with a separate start is not the fire moving. */
function fastestRun(pts, span = 6) {
  let removed = 0;
  let previous = 0;
  const grown = pts.map(([hour, km, , merged]) => {
    if (merged) removed += km - previous;
    previous = km;
    return { hour, km: km - removed };
  });
  const kmAt = hour => {
    const i = d3.bisector(p => p.hour).right(grown, hour) - 1;
    return i >= 0 ? grown[i].km : 0;
  };
  return grown.reduce((best, p) => {
    const gain = p.km - kmAt(p.hour - span);
    return gain > best.km ? { km: gain, hour: p.hour } : best;
  }, { km: 0, hour: 0 });
}
