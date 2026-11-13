/* Spread explorer: one zoomable map of GOES fire pixels, a timeline and a side panel,
   all driven by one state object.

   S.scope    what the charts describe: {type:"all"}, {type:"fire", id} or {type:"region", geo:[[lon,lat],[lon,lat]]}
   S.window   [startHour, endHour) set by the timeline brush, or null for the full period
   S.hour     solar hour index shown on the map
   S.view     map colour: "power", "arrival" or "duration"
   S.measure  timeline measure: "power", "pixels" or "fresh"
   S.mode     "filled" or "reported" power
   S.trail    afterglow length in hours (0, 6 or 24)

   The map always draws every pixel; scope only changes what the charts count. */

const S = {
  scope: { type: "all" }, window: null, hour: null, view: "power", measure: "power", mode: "filled",
  trail: 6, sort: "acres", speed: 24, selecting: false, moment: null,
};
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const UNMEASURED = "#7d8a9c";
const NOW_WHITE = "#ffffff";
const BEFORE_WINDOW = "#6f6660";
const MIN_WINDOW_HOURS = 6;
const CITIES = [
  ["Seattle", -122.33, 47.61, 1], ["Portland", -122.68, 45.52, 1], ["Spokane", -117.43, 47.66, 1],
  ["Boise", -116.2, 43.62, 1], ["Salt Lake City", -111.89, 40.76, 1], ["Reno", -119.81, 39.53, 1],
  ["Sacramento", -121.49, 38.58, 1], ["San Francisco", -122.42, 37.77, 1], ["Las Vegas", -115.14, 36.17, 1],
  ["Bend", -121.31, 44.06, 2], ["Medford", -122.87, 42.33, 2], ["Yakima", -120.51, 46.6, 2],
  ["Missoula", -113.99, 46.87, 2], ["Redding", -122.39, 40.59, 2], ["Twin Falls", -114.46, 42.56, 2],
  ["Elko", -115.76, 40.83, 2], ["Fresno", -119.79, 36.74, 2], ["Eugene", -123.09, 44.05, 2.5],
  ["Burns", -119.05, 43.59, 3], ["Wenatchee", -120.31, 47.42, 3], ["Pendleton", -118.79, 45.67, 3],
  ["Winnemucca", -117.74, 40.97, 3], ["Baker City", -117.83, 44.77, 3], ["Omak", -119.53, 48.41, 3],
  ["Richfield", -112.08, 38.77, 3], ["Susanville", -120.65, 40.42, 3],
].map(([name, lon, lat, minK]) => ({ name, lon, lat, minK }));

let context = [];
let N, firstHour, pixHours, activeAt, firstByHour, maxDuration;
let map, timeline, player;

const fmtAcres = d3.format(".3s");
const fmt1 = d3.format(".1f");
const win = () => S.window || [0, totalHours];
const clampHour = h => { const [a, b] = win(); return Math.max(a, Math.min(b - 1, h)); };
const hourStamp = h => `${fmtDay(hourDate(h))}, ${fmtHour(hourDate(h))}`;
const fmtPower = gw => (gw >= 1 ? `${fmtGW(gw)} GW` : `${fmtInt(gw * 1000)} MW`);
const runById = id => runs.find(r => r.id === id);
const discoveryHour = run => (new Date(run.discovered) - new Date(meta.t0)) / HOUR_MS + run.origin[0] / 15;

function windowLabel() {
  const [a, b] = win();
  const start = fmtDay(hourDate(a));
  const end = fmtDay(hourDate(b - 1));
  return start === end ? start : `${start} to ${end}`;
}

/* ---------- data indexes ---------- */

function indexPixels() {
  N = pixelData.pos.length;
  firstHour = new Int32Array(N).fill(-1);
  pixHours = Array.from({ length: N }, () => []);
  activeAt = new Array(totalHours);
  for (let h = 0; h < totalHours; h++) {
    const flat = pixelData.hours[h] || [];
    const list = [];
    for (let j = 0; j < flat.length; j += 3) {
      const i = flat[j];
      list.push({ i, scans: flat[j + 1], mw: flat[j + 2] });
      if (firstHour[i] < 0) firstHour[i] = h;
      pixHours[i].push(h);
    }
    activeAt[h] = list;
  }
  firstByHour = d3.groups(d3.range(N).filter(i => firstHour[i] >= 0), i => firstHour[i])
    .map(([h, pix]) => ({ h, pix })).sort((a, b) => a.h - b.h);
  maxDuration = d3.max(pixHours, a => a.length);
}

const hoursBurned = (i, h) => d3.bisectRight(pixHours[i], h);

function scopeKey() {
  const s = S.scope;
  return s.type === "fire" ? `f:${s.id}` : s.type === "region" ? `r:${s.geo.flat().join(",")}` : "all";
}

function scopeName() {
  const s = S.scope;
  return s.type === "fire" ? runById(s.id).name : s.type === "region" ? "Selected area" : "All West";
}

function scopeKeep() {
  const s = S.scope;
  if (s.type === "fire") {
    const k = pixelData.fireIndex.get(s.id);
    return i => pixelData.pos[i].fire === k;
  }
  if (s.type === "region") {
    const mask = map.regionMask();
    return i => mask[i] === 1;
  }
  return null;
}

/* Hourly rows for the current scope. Pixel counts always come from the pixel table, so they match
   the map. Power for All West and named fires is the per-scan average from the build; for a drawn
   area it is rebuilt from the hourly pixel table, assuming 12 scans an hour. */
let seriesCache = { key: null, hours: null };
function scopeSeries() {
  const key = scopeKey();
  if (seriesCache.key === key) return seriesCache.hours;
  const keep = scopeKeep();
  const exact = S.scope.type === "region" ? null : seriesById.get(S.scope.type === "fire" ? S.scope.id : "all").hours;
  const hours = d3.range(totalHours).map(h => {
    let n = 0, nPower = 0, fresh = 0, reported = 0, filled = 0;
    for (const r of activeAt[h]) {
      if (keep && !keep(r.i)) continue;
      n++;
      if (r.mw > 0) { nPower++; reported += r.mw * r.scans / 12; }
      filled += Math.abs(r.mw) * r.scans / 12;
      if (firstHour[r.i] === h) fresh++;
    }
    return {
      i: h, date: hourDate(h), hod: h % 24, n, nPower, fresh, withFrp: nPower, noFrp: n - nPower,
      reported: exact ? exact[h].reported : reported / 1000,
      filled: exact ? exact[h].filled : filled / 1000,
    };
  });
  seriesCache = { key, hours };
  return hours;
}

const rowsInWindow = () => { const [a, b] = win(); return scopeSeries().slice(a, b); };

const MEASURES = {
  power: {
    label: () => `Fire radiative power in gigawatts, ${S.mode === "filled" ? "with cloud-flagged pixels estimated" : "reported values only"}`,
    unit: "Gigawatts", value: d => d[S.mode], scaleValue: d => d.filled, fmt: fmtPower, curve: d3.curveMonotoneX,
  },
  pixels: {
    label: () => "Satellite pixels seen burning in each hour",
    unit: "Pixels", value: d => d.n, scaleValue: d => d.n, fmt: v => `${fmtInt(v)} pixels`, curve: d3.curveStepAfter,
  },
  fresh: {
    label: () => "New ground: pixels burning for the first time, per hour",
    unit: "New pixels", value: d => d.fresh, scaleValue: d => d.fresh, fmt: v => `${fmtInt(v)} new pixels`, curve: d3.curveStepAfter,
  },
};

/* ---------- colour ---------- */

const fireRamp = d3.interpolateRgbBasis(["#7a1408", "#c8321a", "#f0701c", "#ffb52e", "#fff3b0"]);
const powerScale = d3.scaleSequentialLog([40, 2500], fireRamp).clamp(true);
const arrivalRamp = t => d3.interpolateViridis(0.2 + 0.8 * t);
const durationRamp = t => d3.interpolateInferno(0.3 + 0.7 * t);
let arrivalScale = d3.scaleSequential([0, 1], arrivalRamp).clamp(true);
let durationScale = d3.scaleSequentialLog([1, 100], durationRamp).clamp(true);

function arrivalColor(h) {
  return h < win()[0] ? BEFORE_WINDOW : arrivalScale(h);
}

function rampCss(scale, ramp) {
  return `linear-gradient(to right, ${d3.range(0, 1.001, 0.1).map(ramp).join(",")})`;
}

function drawLegend() {
  const el = d3.select("#map-legend");
  const key = (cls, color, text) => `<span><i class="${cls}" style="${color ? `background:${color}` : ""}"></i>${text}</span>`;
  let title, ramp, ticks, keys;
  if (S.view === "power") {
    title = "Fire radiative power of each burning pixel";
    ramp = rampCss(powerScale, fireRamp);
    ticks = [[0, "40 MW"], ...[150, 600].map(v => [(Math.log(v) - Math.log(40)) / (Math.log(2500) - Math.log(40)), fmtInt(v)]), [1, "2,500+"]];
    keys = key("", UNMEASURED, "Burning, no measured power") + key("", "var(--scar)", "Burned earlier");
  } else if (S.view === "arrival") {
    const [a, b] = win();
    title = "Date each pixel first burned";
    ramp = rampCss(arrivalScale, arrivalRamp);
    ticks = [[0, fmtDay(hourDate(a))], [0.5, fmtDay(hourDate(Math.floor((a + b) / 2)))], [1, fmtDay(hourDate(b - 1))]];
    keys = key("", NOW_WHITE, "Burning now") + (a > 0 ? key("", BEFORE_WINDOW, `Before ${fmtDay(hourDate(a))}`) : "");
  } else {
    title = "Hours each pixel has burned so far";
    ramp = rampCss(durationScale, durationRamp);
    const [lo, hi] = durationScale.domain();
    ticks = [[0, "1 h"], [Math.log(10 / lo) / Math.log(hi / lo), "10"], [1, `${fmtInt(hi)}+ h`]];
    keys = key("", NOW_WHITE, "Burning now");
  }
  keys += key("outline", "", "Final fire perimeter") + key("ring", "", "Origin");
  el.html(`<div class="lg-title">${title}</div><div class="lg-ramp" style="background:${ramp}"></div>` +
    `<div class="lg-ticks">${ticks.map(([t, label]) => `<span style="left:${(t * 100).toFixed(1)}%">${label}</span>`).join("")}</div>` +
    `<div class="lg-keys">${keys}</div><div class="lg-note" id="lg-note"></div>`);
  if (map) map.updateNote();
}

/* ---------- map ---------- */

function destination([lon, lat], bearingDeg, km) {
  const R = 6371, d = km / R, br = bearingDeg * Math.PI / 180;
  const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [l2 * 180 / Math.PI, p2 * 180 / Math.PI];
}

/* Farthest connected point of a fire at the end of solar hour h: [km, bearing] or null. */
function reachAt(run, h) {
  const t = h + 1 - discoveryHour(run);
  const i = d3.bisector(p => p[0]).right(run.pts, t) - 1;
  return i >= 0 ? run.pts[i] : null;
}

function createMap() {
  const wrap = d3.select("#map");
  const svg = wrap.insert("svg", ":first-child").attr("role", "img")
    .attr("aria-label", "Zoomable map of the western United States showing satellite fire pixels at the selected hour");
  const zoomG = svg.append("g");
  const statesG = zoomG.append("g");
  const studyPath = zoomG.append("path").attr("class", "m-study");
  const scarG = zoomG.append("g").attr("class", "m-pixels m-scar");
  const durG = zoomG.append("g").attr("class", "m-pixels");
  const trailG = zoomG.append("g").attr("class", "m-pixels m-trail");
  const activeG = zoomG.append("g").attr("class", "m-pixels");
  const perimG = zoomG.append("g");
  const reachRing = zoomG.append("path").attr("class", "m-reach");
  const reachLine = zoomG.append("line").attr("class", "m-reach-line");
  const hoverPath = zoomG.append("path").attr("class", "m-hover");
  const boxRect = zoomG.append("rect").attr("class", "m-box").style("display", "none");
  const labelsG = svg.append("g").attr("class", "m-labels");
  const stateLabels = labelsG.append("g");
  const cityLabels = labelsG.append("g");
  const fireLabels = labelsG.append("g");
  const reachLabel = labelsG.append("text").attr("class", "reach-label");
  const scaleBar = svg.append("g").attr("class", "m-scale");
  scaleBar.append("line");
  scaleBar.append("text");

  let W = 0, H = 0, projection, path, kmPx = 1, pxBase = 1;
  let t = d3.zoomIdentity;
  let cx, cy, dstr, quadtree;
  let scarNodes = [], scarHours = [], scarShown = [];
  let durNodes = null, durCount = null;
  let mask = null, maskKey = null;
  let hoverId = null;
  let nowSet = new Map();

  const zoom = d3.zoom().scaleExtent([1, 48])
    .filter(e => (!e.ctrlKey || e.type === "wheel") && !e.button && !e.shiftKey && !S.selecting)
    .on("zoom", e => {
      t = e.transform;
      zoomG.attr("transform", t);
      onTransform();
      if (e.sourceEvent) dismissHint();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function studyRing() {
    const [w, s, e, n] = meta.bbox;
    const steps = 30;
    const edge = (x0, y0, x1, y1) => d3.range(steps).map(k => [x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps]);
    return [...edge(w, s, e, s), ...edge(e, s, e, n), ...edge(e, n, w, n), ...edge(w, n, w, s), [w, s]];
  }

  function layout() {
    const node = wrap.node();
    W = Math.max(300, node.clientWidth);
    H = Math.max(300, node.clientHeight);
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    const ring = studyRing();
    projection = d3.geoConicConformal().parallels([38, 47]).rotate([117.5, 0])
      .fitExtent([[18, 18], [W - 18, H - 18]], { type: "MultiPoint", coordinates: ring });
    path = d3.geoPath(projection);
    zoom.extent([[0, 0], [W, H]]).translateExtent([[-W * 0.4, -H * 0.15], [W * 1.4, H * 1.15]]);

    const c = projection([-117.5, 42]);
    const c2 = projection([-117.5 + 1 / (111.32 * Math.cos(42 * Math.PI / 180)), 42]);
    kmPx = Math.hypot(c2[0] - c[0], c2[1] - c[1]);
    pxBase = kmPx * 2.2;

    cx = new Float32Array(N);
    cy = new Float32Array(N);
    dstr = new Array(N);
    for (let i = 0; i < N; i++) {
      const pts = pixelData.pos[i].corners.map(p => projection(p));
      cx[i] = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      cy[i] = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      dstr[i] = "M" + pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("L") + "Z";
    }
    quadtree = d3.quadtree().x(i => cx[i]).y(i => cy[i]).addAll(d3.range(N));

    statesG.selectAll("path").data(states.features).join("path").attr("class", "m-state").attr("d", path);
    studyPath.attr("d", path({ type: "LineString", coordinates: ring }));
    stateLabels.selectAll("text").data(states.features).join("text").attr("class", "state-label")
      .attr("text-anchor", "middle").text(d => d.properties.name)
      .each(function (d) { d.xy = path.centroid(d); });

    perimG.selectAll("path").data(context, d => d.name).join("path")
      .attr("class", d => `m-perim${d.runId ? " named" : ""}`)
      .attr("d", d => path(d.geo))
      .each(function (d) { d.bounds = path.bounds(d.geo); d.xy = projection(d.origin); })
      .each(d => {
        // Put the name on the left when another named fire sits just to the right.
        d.labelLeft = !!d.runId && context.some(o => o !== d && o.runId && projection(o.origin)[0] - d.xy[0] > 0
          && projection(o.origin)[0] - d.xy[0] < 120 && Math.abs(projection(o.origin)[1] - d.xy[1]) < 14);
      })
      .on("click", (event, d) => {
        if (d.runId) setScope(S.scope.type === "fire" && S.scope.id === d.runId ? { type: "all" } : { type: "fire", id: d.runId });
        else flyTo(d.bounds);
      });

    const scar = scarG.selectAll("path").data(firstByHour, d => d.h).join("path")
      .attr("d", d => d.pix.map(i => dstr[i]).join(""));
    scarNodes = scar.nodes();
    scarHours = firstByHour.map(d => d.h);
    scarShown = scarNodes.map(() => null);
    durG.selectAll("path").remove();
    durNodes = null;

    for (const city of CITIES) city.xy = projection([city.lon, city.lat]);
    cityLabels.selectAll("g").data(CITIES).join(enter => {
      const g = enter.append("g").attr("class", "city");
      g.append("circle").attr("r", 1.8);
      g.append("text").attr("x", 5).attr("y", 3.5).text(d => d.name);
      return g;
    });

    fireLabels.selectAll("g").data(context, d => d.name).join(enter => {
      const g = enter.append("g");
      g.filter(d => d.runId).append("circle").attr("class", "origin").attr("r", 4)
        .style("pointer-events", "all").style("cursor", "pointer")
        .on("click", (event, d) => setScope({ type: "fire", id: d.runId }));
      g.append("text").attr("class", d => `fire-label${d.runId ? "" : " minor"}`)
        .attr("y", 4).text(d => d.name);
      return g;
    }).select("text")
      .attr("x", d => (d.runId ? (d.labelLeft ? -8 : 8) : 0))
      .attr("text-anchor", d => (d.runId ? (d.labelLeft ? "end" : "start") : "middle"));

    mask = null;
    paintScar();
    drawRegion();
    svg.call(zoom.transform, targetTransform());
    renderHour();
  }

  function boundsTransform([[x0, y0], [x1, y1]], maxK = 16, fill = 0.62) {
    const k = Math.max(1, Math.min(maxK, fill / Math.max((x1 - x0) / W, (y1 - y0) / H)));
    return d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }

  function targetTransform() {
    if (S.scope.type === "fire") {
      const d = context.find(p => p.runId === S.scope.id);
      if (d) return boundsTransform(d.bounds);
    }
    return S.scope.type === "region" ? t : d3.zoomIdentity;
  }

  function flyTo(bounds) {
    const target = bounds ? boundsTransform(bounds) : targetTransform();
    svg.transition().duration(REDUCED_MOTION ? 0 : 900).call(zoom.transform, target);
  }

  // Never below a hairline, so neighbouring pixels of one colour do not show seams.
  const pad = minPx => Math.max(0.7, minPx - pxBase * t.k);

  function onTransform() {
    scarG.attr("stroke-width", pad(2.6));
    durG.attr("stroke-width", pad(3));
    trailG.attr("stroke-width", pad(3.4));
    activeG.attr("stroke-width", pad(4.4));
    stateLabels.selectAll("text").attr("transform", d => `translate(${t.apply(d.xy)})`)
      .style("display", t.k < 3.2 ? null : "none");
    cityLabels.selectAll("g").attr("transform", d => `translate(${t.apply(d.xy)})`)
      .style("display", d => (t.k >= d.minK ? null : "none"));
    fireLabels.selectAll("g").attr("transform", d => `translate(${t.apply(d.xy)})`)
      .style("display", d => (d.runId || t.k >= 2.4 ? null : "none"));
    placeReachLabel();
    const km = d3.least([2, 5, 10, 20, 50, 100, 200, 500], k => Math.abs(k * kmPx * t.k - 90));
    const len = km * kmPx * t.k;
    scaleBar.attr("transform", `translate(${W - 16 - len},${H - 18})`);
    scaleBar.select("line").attr("x1", 0).attr("x2", len);
    scaleBar.select("text").attr("x", len).attr("y", -6).attr("text-anchor", "end").text(`${km} km`);
    updateNote();
  }

  function updateNote() {
    const el = document.getElementById("lg-note");
    if (el) el.textContent = pad(4.4) > 1 ? "Pixels are drawn larger than life at this zoom. Zoom in for true footprints." : "Pixels are at true ground size.";
  }

  function paintScar() {
    const [a, b] = win();
    arrivalScale = d3.scaleSequential([a, Math.max(a + 1, b - 1)], arrivalRamp).clamp(true);
    for (let k = 0; k < scarNodes.length; k++) {
      scarNodes[k].style.color = S.view === "arrival" ? arrivalColor(scarHours[k]) : "";
    }
    scarG.style("display", S.view === "duration" ? "none" : null);
    durG.style("display", S.view === "duration" ? null : "none");
    trailG.style("display", S.view === "power" ? null : "none");
  }

  function ensureDuration() {
    if (durNodes) return;
    durationScale = d3.scaleSequentialLog([1, Math.max(10, d3.quantile(pixHours.map(a => a.length).filter(Boolean).sort(d3.ascending), 0.995))], durationRamp).clamp(true);
    const burned = d3.range(N).filter(i => firstHour[i] >= 0);
    const sel = durG.selectAll("path").data(burned).join("path").attr("d", i => dstr[i]).style("display", "none");
    durNodes = new Array(N);
    sel.each(function (i) { durNodes[i] = this; });
    durCount = new Int32Array(N);
  }

  function renderHour() {
    const h = S.hour;
    const active = activeAt[h] || [];
    nowSet = new Map(active.map(r => [r.i, r]));

    if (S.view !== "duration") {
      for (let k = 0; k < scarNodes.length; k++) {
        const show = scarHours[k] <= h;
        if (scarShown[k] !== show) {
          scarNodes[k].style.display = show ? "" : "none";
          scarShown[k] = show;
        }
      }
    } else {
      ensureDuration();
      for (let i = 0; i < N; i++) {
        const node = durNodes[i];
        if (!node) continue;
        const count = firstHour[i] <= h ? hoursBurned(i, h) : 0;
        if (count !== durCount[i]) {
          durCount[i] = count;
          node.style.display = count ? "" : "none";
          if (count) node.style.color = durationScale(count);
        }
      }
    }

    activeG.selectAll("path").data(active, d => d.i).join("path")
      .attr("d", d => dstr[d.i])
      .style("color", d => (S.view === "power" ? (d.mw > 0 ? powerScale(d.mw) : UNMEASURED) : NOW_WHITE));
    if (S.view === "power") activeG.selectAll("path").sort((p, q) => (p.mw > 0 ? p.mw : 0) - (q.mw > 0 ? q.mw : 0));

    let trail = [];
    if (S.view === "power" && S.trail > 0) {
      const last = new Map();
      for (let g = Math.max(0, h - S.trail); g < h; g++) {
        for (const r of activeAt[g]) if (!nowSet.has(r.i)) last.set(r.i, g);
      }
      trail = [...last];
    }
    trailG.selectAll("path").data(trail, d => d[0]).join("path")
      .attr("d", d => dstr[d[0]])
      .style("opacity", d => 0.12 + 0.5 * (1 - (h - d[1]) / S.trail));

    drawReach();
    document.getElementById("clock-date").textContent = `${fmtDay(hourDate(h))} · ${fmtHour(hourDate(h))}`;
    document.getElementById("clock-sub").textContent = `local solar time · ${isNight(h % 24) ? "night" : "day"}`;
  }

  let reachXY = null;
  function drawReach() {
    const run = S.scope.type === "fire" ? runById(S.scope.id) : null;
    const p = run ? reachAt(run, S.hour) : null;
    reachRing.style("display", p ? null : "none");
    reachLine.style("display", p ? null : "none");
    reachXY = null;
    if (p) {
      const o = projection(run.origin);
      const far = projection(destination(run.origin, p[2], p[1]));
      reachRing.attr("d", path(d3.geoCircle().center(run.origin).radius(p[1] / 111.195).precision(3)()));
      reachLine.attr("x1", o[0]).attr("y1", o[1]).attr("x2", far[0]).attr("y2", far[1]);
      reachXY = far;
      reachLabel.text(`${fmtInt(p[1])} km ${compass(p[2])}`);
    }
    placeReachLabel();
  }

  function placeReachLabel() {
    reachLabel.style("display", reachXY ? null : "none");
    if (reachXY) {
      const [x, y] = t.apply(reachXY);
      reachLabel.attr("x", x + 8).attr("y", y - 6);
    }
  }

  function selectionChanged() {
    perimG.selectAll("path").classed("selected", d => S.scope.type === "fire" && d.runId === S.scope.id);
    drawRegion();
    drawReach();
  }

  function highlight(id) {
    perimG.selectAll("path").classed("hover", d => id != null && d.runId === id);
  }

  /* Region box. Stored as two lon/lat corners; a rectangle in projected space. */
  function regionRect() {
    const [p0, p1] = S.scope.geo.map(g => projection(g));
    return [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
  }

  function drawRegion() {
    if (S.scope.type !== "region") {
      boxRect.style("display", "none");
      return;
    }
    const [x0, y0, x1, y1] = regionRect();
    boxRect.style("display", null).attr("x", x0).attr("y", y0).attr("width", x1 - x0).attr("height", y1 - y0);
  }

  function regionMask() {
    const key = scopeKey();
    if (mask && maskKey === key) return mask;
    const [x0, y0, x1, y1] = regionRect();
    mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = cx[i] >= x0 && cx[i] <= x1 && cy[i] >= y0 && cy[i] <= y1 ? 1 : 0;
    maskKey = key;
    return mask;
  }

  /* Drag a box: Shift-drag, or any drag while Select area is on. */
  let drag = null;
  svg.on("pointerdown.select", event => {
    if (!(event.shiftKey || S.selecting) || event.button) return;
    event.preventDefault();
    const start = t.invert(d3.pointer(event, svg.node()));
    drag = { start, end: start };
    svg.node().setPointerCapture(event.pointerId);
    tooltip.hide();
  });
  svg.on("pointermove.select", event => {
    if (!drag) return;
    drag.end = t.invert(d3.pointer(event, svg.node()));
    const [x0, y0] = drag.start, [x1, y1] = drag.end;
    boxRect.style("display", null).attr("x", Math.min(x0, x1)).attr("y", Math.min(y0, y1))
      .attr("width", Math.abs(x1 - x0)).attr("height", Math.abs(y1 - y0));
  });
  svg.on("pointerup.select pointercancel.select", event => {
    if (!drag) return;
    const { start, end } = drag;
    drag = null;
    svg.node().releasePointerCapture(event.pointerId);
    const bigEnough = Math.abs(end[0] - start[0]) * t.k > 8 && Math.abs(end[1] - start[1]) * t.k > 8;
    setSelecting(false);
    if (bigEnough) {
      const round = g => g.map(v => +v.toFixed(3));
      setScope({ type: "region", geo: [round(projection.invert(start)), round(projection.invert(end))] });
    } else {
      drawRegion();
    }
  });

  /* Nearest pixel that has burned by the current hour. */
  function nearestBurned(bx, by, r) {
    let best = -1, bd = r * r;
    const h = S.hour;
    quadtree.visit((node, x0, y0, x1, y1) => {
      if (x0 > bx + r || x1 < bx - r || y0 > by + r || y1 < by - r) return true;
      if (!node.length) {
        let n = node;
        do {
          const i = n.data;
          const d = (cx[i] - bx) ** 2 + (cy[i] - by) ** 2;
          if (d < bd && firstHour[i] <= h) { bd = d; best = i; }
        } while ((n = n.next));
      }
      return false;
    });
    return best;
  }

  function pixelTip(event, i) {
    const p = pixelData.pos[i];
    const h = S.hour;
    const rec = nowSet.get(i);
    const run = runs.find(r => pixelData.fireIndex.get(r.id) === p.fire);
    const rows = [];
    if (rec) {
      rows.push(rec.mw > 0 ? [`${fmtInt(rec.mw)} MW`, "measured power", powerScale(rec.mw)]
        : rec.mw < 0 ? [`about ${fmtInt(-rec.mw)} MW`, "estimated, cloud-flagged", UNMEASURED]
        : ["No power value", "faint detection", UNMEASURED]);
      rows.push([`${rec.scans} of 12`, "scans saw it this hour"]);
    } else {
      rows.push(["Not burning", "this hour", cssVar("--context")]);
    }
    rows.push([hourStamp(firstHour[i]), "first burned"]);
    const hrs = hoursBurned(i, h);
    rows.push([`${hrs} h`, "burning so far"]);
    tooltip.show(event.clientX, event.clientY,
      `${run ? `${run.name} fire` : "Fire pixel"} · ${p.lat.toFixed(2)}°N ${Math.abs(p.lon).toFixed(2)}°W`, rows);
  }

  svg.on("pointermove.hover", event => {
    if (drag || event.buttons) return;
    const [bx, by] = t.invert(d3.pointer(event, svg.node()));
    const i = nearestBurned(bx, by, Math.max(pxBase * 1.1, 7 / t.k));
    if (i >= 0) {
      if (hoverId !== i) hoverPath.attr("d", dstr[i]).style("display", null);
      hoverId = i;
      pixelTip(event, i);
      return;
    }
    hoverId = null;
    hoverPath.style("display", "none");
    const d = d3.select(event.target).datum();
    if (d && d.acres && d.geo) {
      tooltip.show(event.clientX, event.clientY, `${d.name} fire${d.state ? `, ${d.state}` : ""}`, [
        [fmtInt(d.acres), "acres, final perimeter"],
        [fmtDay(new Date(d.discovered)), "discovered"],
        ...(d.cause ? [[d.cause, "cause"]] : []),
        [d.runId ? "Click" : "Click", d.runId ? "to chart this fire" : "to zoom here"],
      ]);
    } else {
      tooltip.hide();
    }
  });
  svg.on("pointerleave.hover", () => {
    hoverId = null;
    hoverPath.style("display", "none");
    tooltip.hide();
  });

  function dismissHint() {
    document.getElementById("map-hint").classList.add("gone");
  }

  d3.select("#zoom-in").on("click", () => svg.transition().duration(REDUCED_MOTION ? 0 : 250).call(zoom.scaleBy, 1.8));
  d3.select("#zoom-out").on("click", () => svg.transition().duration(REDUCED_MOTION ? 0 : 250).call(zoom.scaleBy, 1 / 1.8));
  d3.select("#zoom-home").on("click", () => svg.transition().duration(REDUCED_MOTION ? 0 : 600).call(zoom.transform, d3.zoomIdentity));

  return {
    layout, renderHour, paintScar, selectionChanged, highlight, regionMask, flyTo, updateNote, dismissHint,
    zoomBy: k => svg.transition().duration(REDUCED_MOTION ? 0 : 250).call(zoom.scaleBy, k),
  };
}

/* ---------- timeline ---------- */

function createTimeline() {
  const svg = d3.select("#timeline").append("svg").attr("role", "img")
    .attr("aria-label", "Timeline of the selected measure by hour, with a strip below for choosing a span of days");
  const margin = { top: 18, right: 14, bottom: 20, left: 46 };
  const focusH = 150, gap = 24, stripH = 34;
  const clipRect = svg.append("defs").append("clipPath").attr("id", "tl-clip").append("rect");
  const plot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const gridG = plot.append("g").attr("class", "grid");
  const nightG = plot.append("g").attr("clip-path", "url(#tl-clip)");
  const dataG = plot.append("g").attr("clip-path", "url(#tl-clip)");
  const area = dataG.append("path").attr("class", "value-area");
  const line = dataG.append("path").attr("class", "value-line");
  const xAxisG = plot.append("g").attr("class", "axis");
  const yAxisG = plot.append("g").attr("class", "axis");
  const unitLabel = plot.append("text").attr("y", -7).attr("x", -margin.left + 2);
  const peakLabel = plot.append("text").attr("class", "peak-label");
  const emptyMsg = plot.append("text").attr("class", "empty-msg").attr("text-anchor", "middle");
  const crosshair = plot.append("line").attr("class", "crosshair").style("display", "none");
  const playhead = plot.append("g").attr("class", "playhead").style("pointer-events", "none");
  playhead.append("line");
  playhead.append("path").attr("d", "M-5,-7h10v4l-5,5l-5,-5z");
  const playDot = plot.append("circle").attr("class", "playhead-dot").attr("r", 4).style("pointer-events", "none");
  const overlay = plot.append("rect").attr("fill", "transparent").style("cursor", "ew-resize").style("touch-action", "none");

  const strip = svg.append("g");
  const stripArea = strip.append("path").attr("class", "context-area");
  const stripAxisG = strip.append("g").attr("class", "axis");
  const brushG = strip.append("g");
  const stripNow = strip.append("line").attr("class", "context-now");
  const brush = d3.brushX().on("brush end", onBrush);

  let x, y, rows = [], innerW = 0, stripX = d3.scaleUtc(), syncing = false, dragging = false;

  function onBrush(event) {
    if (syncing) return;
    const sel = event.selection;
    if (!sel) {
      if (event.type === "end") setWindow(null);
      return;
    }
    const hourAt = px => (stripX.invert(px) - hourDate(0)) / HOUR_MS;
    const a = Math.max(0, Math.min(totalHours - MIN_WINDOW_HOURS, Math.floor(hourAt(sel[0]))));
    const b = Math.min(totalHours, Math.max(a + MIN_WINDOW_HOURS, Math.ceil(hourAt(sel[1]))));
    setWindow([a, b], { animate: false });
  }

  function moveBrush() {
    syncing = true;
    brushG.call(brush.move, S.window ? S.window.map(i => stripX(hourDate(i))) : null);
    syncing = false;
  }

  function draw({ animate = false } = {}) {
    const width = Math.max(300, document.getElementById("timeline").clientWidth);
    const totalH = margin.top + focusH + margin.bottom + gap + stripH + 18;
    svg.attr("viewBox", `0 0 ${width} ${totalH}`).attr("height", totalH);
    innerW = width - margin.left - margin.right;
    clipRect.attr("width", innerW).attr("height", focusH + 1);

    const m = MEASURES[S.measure];
    const all = scopeSeries();
    rows = rowsInWindow();
    const [a, b] = win();
    const days = (b - a) / 24;
    x = d3.scaleUtc().domain([hourDate(a), hourDate(b - 1)]).range([0, innerW]);
    const yMax = d3.max(rows, m.scaleValue) || 0;
    y = d3.scaleLinear().domain([0, (yMax || 1) * 1.08]).nice(4).range([focusH, 0]);

    gridG.call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));
    yAxisG.call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat(d3.format(",")));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${focusH})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, innerW / 100)).tickSizeOuter(0)
        .tickFormat(d => (d.getUTCHours() !== 0 ? fmtHour(d) : fmtDay(d))));
    unitLabel.text(m.unit);

    nightG.selectAll("rect").data(days <= NIGHT_BAND_MAX_DAYS ? nightSpans(a, b) : []).join("rect")
      .attr("class", "night-band")
      .attr("x", d => x(hourDate(d[0]))).attr("width", d => x(hourDate(d[1])) - x(hourDate(d[0])))
      .attr("height", focusH);

    const areaGen = d3.area().x(d => x(d.date)).y0(focusH).y1(d => y(m.value(d))).curve(m.curve);
    const apply = sel => (animate && !REDUCED_MOTION ? sel.transition().duration(400) : sel);
    area.datum(rows);
    line.datum(rows);
    apply(area).attr("d", areaGen);
    apply(line).attr("d", areaGen.lineY1());

    const peak = d3.greatest(rows, m.value);
    const hasData = peak && m.value(peak) > 0;
    peakLabel.style("display", hasData ? null : "none");
    emptyMsg.style("display", hasData ? "none" : null).attr("x", innerW / 2).attr("y", focusH / 2)
      .text(`No fire detected for ${scopeName()} in ${windowLabel()}.`);
    if (hasData) {
      const px = x(peak.date);
      const right = px > innerW * 0.7;
      peakLabel.attr("x", px + (right ? -8 : 8)).attr("y", Math.max(10, y(m.value(peak)) - 6))
        .attr("text-anchor", right ? "end" : "start")
        .text(`Peak ${m.fmt(m.value(peak))}, ${hourStamp(peak.i)}`);
    }

    const hourAtPointer = event => {
      const [mx] = d3.pointer(event, overlay.node());
      const i = d3.bisector(d => d.date).center(rows, x.invert(Math.max(0, Math.min(innerW, mx))));
      return rows[i];
    };
    overlay.attr("width", innerW).attr("height", focusH)
      .on("pointerdown", event => {
        dragging = true;
        overlay.node().setPointerCapture(event.pointerId);
        const d = hourAtPointer(event);
        if (d) { player.stop(); setHour(d.i); }
      })
      .on("pointermove", event => {
        const d = hourAtPointer(event);
        if (!d) return;
        if (dragging) { setHour(d.i); }
        const px = x(d.date);
        crosshair.style("display", dragging ? "none" : null).attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", focusH);
        tooltip.show(event.clientX, event.clientY, `${hourStamp(d.i)} solar${isNight(d.hod) ? " (night)" : ""}`, [
          [fmtPower(d.filled), "power, gap-filled", cssVar("--ember")],
          [fmtPower(d.reported), "power, reported only"],
          [fmtInt(d.n), "pixels burning"],
          [fmtInt(d.fresh), "of them new ground"],
        ]);
      })
      .on("pointerup pointercancel", event => {
        dragging = false;
        overlay.node().releasePointerCapture(event.pointerId);
      })
      .on("pointerleave", () => {
        crosshair.style("display", "none");
        tooltip.hide();
      });

    const stripTop = margin.top + focusH + margin.bottom + gap;
    strip.attr("transform", `translate(${margin.left},${stripTop})`);
    stripX = d3.scaleUtc().domain([hourDate(0), hourDate(totalHours - 1)]).range([0, innerW]);
    const stripY = d3.scaleLinear().domain([0, d3.max(all, m.scaleValue) || 1]).range([stripH, 0]);
    stripArea.datum(all).attr("d", d3.area().x(d => stripX(d.date)).y0(stripH).y1(d => stripY(m.scaleValue(d))));
    stripAxisG.attr("transform", `translate(0,${stripH})`)
      .call(d3.axisBottom(stripX).ticks(d3.utcWeek.every(innerW < 480 ? 2 : 1)).tickSize(0).tickPadding(6).tickFormat(fmtDay));
    brush.extent([[0, 0], [innerW, stripH]]);
    brushG.call(brush);
    moveBrush();

    document.getElementById("timeline-title").textContent = `${m.label()}. ${scopeName()}, ${windowLabel()}.`;
    movePlayhead();
  }

  function movePlayhead() {
    if (!x) return;
    const d = scopeSeries()[S.hour];
    const px = x(d.date);
    playhead.attr("transform", `translate(${px},0)`).select("line").attr("y1", 0).attr("y2", focusH);
    playDot.attr("cx", px).attr("cy", y(MEASURES[S.measure].value(d)));
    const sx = stripX(d.date);
    stripNow.attr("x1", sx).attr("x2", sx).attr("y1", -3).attr("y2", stripH + 3);
  }

  return { draw, movePlayhead };
}

/* ---------- playback ---------- */

function createPlayer() {
  const button = document.getElementById("play");
  let timer = null;

  function stop() {
    if (!timer) return;
    timer.stop();
    timer = null;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Play");
  }

  function play() {
    const [a, b] = win();
    if (S.hour >= b - 1) setHour(a);
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", "Pause");
    map.dismissHint();
    let last = 0, acc = 0;
    timer = d3.timer(elapsed => {
      acc += Math.min(120, elapsed - last) / 1000 * S.speed;
      last = elapsed;
      if (acc < 1) return;
      const step = Math.floor(acc);
      acc -= step;
      const end = win()[1] - 1;
      const next = S.hour + step;
      if (next >= end) {
        setHour(end);
        stop();
      } else {
        setHour(next);
      }
    });
  }

  button.addEventListener("click", () => (timer ? stop() : play()));
  return { play, stop, toggle: () => (timer ? stop() : play()), get playing() { return !!timer; } };
}

/* ---------- side panel ---------- */

function updateReadout() {
  const d = scopeSeries()[S.hour];
  document.getElementById("stat-n").textContent = fmtInt(d.n);
  document.getElementById("stat-fresh").textContent = fmtInt(d.fresh);
  const [value, unit] = fmtPower(d.filled).split(" ");
  document.getElementById("stat-power").innerHTML = `${value}<small>${unit}</small>`;
}

function updateScopeText() {
  const s = S.scope;
  document.getElementById("scope-name").textContent = s.type === "fire" ? `${scopeName()} fire` : scopeName();
  document.getElementById("scope-clear").hidden = s.type === "all";
  let sub;
  if (s.type === "fire") {
    const r = runById(s.id);
    sub = `${r.place} · ${fmtInt(r.acres)} acres · discovered ${fmtDay(new Date(r.discovered))}${r.cause ? ` · ${r.cause.toLowerCase()} cause` : ""}`;
  } else if (s.type === "region") {
    sub = `${fmtInt(d3.sum(map.regionMask()))} pixel positions inside the box you drew. Power here is rebuilt from hourly pixel means.`;
  } else {
    sub = `Every fire pixel in the study area, ${fmtInt(N)} pixel positions.`;
  }
  document.getElementById("scope-sub").textContent = sub;
}

const SORTS = {
  acres: { key: r => -r.acres, text: r => `${fmtAcres(r.acres).replace("k", "k ac")}` },
  peak: { key: r => -r.peakGW, text: r => fmtPower(r.peakGW) },
  fastest: { key: r => -r.fastest.km, text: r => `${fmtInt(r.fastest.km)} km` },
  start: { key: r => +new Date(r.discovered), text: r => fmtDay(new Date(r.discovered)) },
};
const SPARK_W = 96, SPARK_H = 22;

function buildFireList() {
  const sx = d3.scaleLinear([0, totalHours - 1], [0, SPARK_W]);
  for (const r of runs) {
    const hours = seriesById.get(r.id).hours;
    r.peakGW = d3.max(hours, d => d.filled);
    // Daily peaks on a square-root scale: hourly power is too spiky to read at 96 px.
    const sy = d3.scaleSqrt([0, r.peakGW || 1], [SPARK_H, 1]);
    const bins = d3.range(0, totalHours, 24).map(i => ({ i, v: d3.max(hours.slice(i, i + 24), d => d.filled) }));
    r.spark = d3.area().x(d => sx(d.i)).y0(SPARK_H).y1(d => sy(d.v)).curve(d3.curveStepAfter)([...bins, { i: totalHours - 1, v: bins[bins.length - 1].v }]);
  }
  const rows = d3.select("#fire-list").selectAll("button").data(runs, r => r.id).join("button")
    .attr("type", "button").attr("class", "fire-row").attr("role", "listitem")
    .on("click", (_, r) => setScope(S.scope.type === "fire" && S.scope.id === r.id ? { type: "all" } : { type: "fire", id: r.id }))
    .on("pointerenter focus", (_, r) => map.highlight(r.id))
    .on("pointerleave blur", () => map.highlight(null));
  const name = rows.append("span").attr("class", "fr-name");
  name.append("i").attr("class", "fr-dot");
  name.append("span").text(r => r.name);
  name.append("small").text(r => r.place);
  const spark = rows.append("svg").attr("width", SPARK_W).attr("height", SPARK_H).attr("aria-hidden", "true");
  spark.append("path").attr("class", "spark-area").attr("d", r => r.spark);
  spark.append("line").attr("class", "spark-now").attr("y1", 0).attr("y2", SPARK_H);
  rows.append("span").attr("class", "fr-value");
  sortFireList();
}

function sortFireList() {
  const sort = SORTS[S.sort];
  d3.select("#fire-list").selectAll("button").sort((a, b) => d3.ascending(sort.key(a), sort.key(b)))
    .select(".fr-value").text(sort.text);
}

function updateFireList() {
  const px = S.hour / (totalHours - 1) * SPARK_W;
  const rows = d3.select("#fire-list").selectAll("button");
  rows.attr("aria-pressed", r => S.scope.type === "fire" && S.scope.id === r.id)
    .attr("title", r => `${r.name}: ${fmtPower(seriesById.get(r.id).hours[S.hour].filled)} at ${hourStamp(S.hour)}`);
  rows.select(".spark-now").attr("x1", px).attr("x2", px);
  rows.select(".fr-dot").classed("on", r => {
    const d = seriesById.get(r.id).hours[S.hour];
    return d.withFrp + d.noFrp > 0;
  });
}

function createTod() {
  const svg = d3.select("#tod").append("svg").attr("role", "img")
    .attr("aria-label", "Average pixels burning at each solar hour of the day, for the selection and span of days");
  const margin = { top: 8, right: 4, bottom: 18, left: 30 };
  const height = 128;
  const nightG = svg.append("g");
  const gridG = svg.append("g").attr("class", "grid");
  const barsG = svg.append("g").style("pointer-events", "none");
  const nowRect = svg.append("rect").attr("class", "tod-bar-now").attr("rx", 3);
  const xAxisG = svg.append("g").attr("class", "axis");
  const yAxisG = svg.append("g").attr("class", "axis");
  const hitG = svg.append("g");
  let x, y, bins, barW;

  function draw() {
    const width = Math.max(240, document.getElementById("tod").clientWidth);
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const innerW = width - margin.left - margin.right;
    const bottom = height - margin.bottom;
    bins = hourProfile(rowsInWindow());
    x = d3.scaleBand().domain(d3.range(24)).range([margin.left, margin.left + innerW]);
    y = d3.scaleLinear().domain([0, d3.max(bins, d => d.total) || 1]).nice(3).range([bottom, margin.top]);
    barW = Math.max(2, x.bandwidth() - 2);
    const barX = h => x(h) + (x.bandwidth() - barW) / 2;

    nightG.selectAll("rect").data([[0, NIGHT_END], [NIGHT_START, 24]]).join("rect").attr("class", "night-band")
      .attr("x", d => x(d[0])).attr("width", d => (d[1] - d[0]) * x.step()).attr("y", margin.top).attr("height", bottom - margin.top);
    gridG.attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-innerW).tickFormat(""));
    yAxisG.attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${bottom})`)
      .call(d3.axisBottom(x).tickValues([0, 6, 12, 18]).tickSizeOuter(0).tickFormat(hourLabel));

    barsG.selectAll("path.bar-power").data(bins, d => d.h).join("path").attr("class", "bar-power")
      .attr("d", d => {
        const top = y(d.withFrp);
        return d.noFrp > 0 ? `M${barX(d.h)},${top}h${barW}v${bottom - top}h${-barW}Z` : roundedTopBar(barX(d.h), top, barW, bottom - top, 3);
      });
    barsG.selectAll("path.bar-nopower").data(bins, d => d.h).join("path").attr("class", "bar-nopower")
      .attr("d", d => roundedTopBar(barX(d.h), y(d.total), barW, Math.max(0, y(d.withFrp) - y(d.total) - 1), 3));

    hitG.selectAll("rect").data(bins, d => d.h).join("rect").attr("class", "hit")
      .attr("x", d => x(d.h)).attr("width", x.step()).attr("y", margin.top).attr("height", bottom - margin.top)
      .on("pointermove", (event, d) => tooltip.show(event.clientX, event.clientY, `${hourLabel(d.h)} solar${isNight(d.h) ? " (night)" : ""}`, [
        [fmt1(d.withFrp), "pixels with measured power", cssVar("--ember")],
        [fmt1(d.noFrp), "pixels without", cssVar("--nopower")],
        [fmtPct(d.share), "have no measured power"],
        ["Click", "to move the map to this hour"],
      ]))
      .on("pointerleave", () => tooltip.hide())
      .on("click", (_, d) => {
        player.stop();
        setHour(clampHour(Math.floor(S.hour / 24) * 24 + d.h));
      });

    const peak = d3.greatest(bins, d => d.total);
    document.getElementById("tod-note").textContent = peak && peak.total
      ? `mean pixels per hour · peak ${hourLabel(peak.h)}` : "no detections";
    mark();
  }

  function mark() {
    if (!x) return;
    const h = S.hour % 24;
    const d = bins[h];
    const top = Math.min(y(d.total), y.range()[0] - 3);
    nowRect.attr("x", x(h) + (x.bandwidth() - barW) / 2 - 1.5).attr("width", barW + 3)
      .attr("y", top - 1.5).attr("height", y.range()[0] - top + 1.5);
  }

  return { draw, mark };
}

function createReach() {
  const svg = d3.select("#reach").append("svg").attr("role", "img")
    .attr("aria-label", "Farthest fire pixel connected to the fire's origin, by days since discovery");
  const margin = { top: 8, right: 8, bottom: 30, left: 30 };
  const height = 138;
  const gridG = svg.append("g").attr("class", "grid");
  const line = svg.append("path").attr("class", "reach-line");
  const mergeG = svg.append("g");
  const future = svg.append("rect").attr("class", "reach-future");
  const dot = svg.append("circle").attr("class", "playhead-dot").attr("r", 4);
  const xAxisG = svg.append("g").attr("class", "axis");
  const yAxisG = svg.append("g").attr("class", "axis");
  const xLabel = svg.append("text").attr("text-anchor", "end").text("Days since discovery");
  const overlay = svg.append("rect").attr("fill", "transparent").style("cursor", "ew-resize").style("touch-action", "none");
  let x, y, run = null;

  function draw() {
    run = S.scope.type === "fire" ? runById(S.scope.id) : null;
    document.getElementById("reach").style.display = run ? "" : "none";
    document.getElementById("reach-empty").style.display = run ? "none" : "";
    document.getElementById("reach-note").textContent = "";
    if (!run) return;
    const width = Math.max(240, document.getElementById("reach").clientWidth);
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const innerW = width - margin.left - margin.right;
    const bottom = height - margin.bottom;
    const lastDay = Math.min(Math.max(run.lastHour / 24 + 1, 3), (totalHours - discoveryHour(run)) / 24);
    x = d3.scaleLinear().domain([0, lastDay]).range([margin.left, margin.left + innerW]);
    y = d3.scaleLinear().domain([0, run.farthest]).nice(3).range([bottom, margin.top]);
    gridG.attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-innerW).tickFormat(""));
    yAxisG.attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6).tickFormat(d => `${d}`));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(5).tickSizeOuter(0));
    xLabel.attr("x", margin.left + innerW).attr("y", height - 2);
    const pts = [[0, 0], ...run.pts.map(p => [p[0] / 24, p[1]]), [lastDay, run.farthest]];
    line.attr("d", d3.line().x(p => x(p[0])).y(p => y(p[1])).curve(d3.curveStepAfter)(pts));
    mergeG.selectAll("circle").data(run.pts.filter(p => p[3] === 1)).join("circle").attr("class", "merge-ring").attr("r", 3.5)
      .attr("cx", p => x(p[0] / 24)).attr("cy", p => y(p[1]));
    const seek = event => {
      const [mx] = d3.pointer(event, svg.node());
      const day = x.invert(Math.max(margin.left, Math.min(margin.left + innerW, mx)));
      player.stop();
      const h = Math.round(discoveryHour(run) + day * 24);
      if (S.window && (h < S.window[0] || h >= S.window[1])) setWindow(null);
      setHour(clampHour(h));
    };
    overlay.attr("x", margin.left).attr("y", margin.top).attr("width", innerW).attr("height", bottom - margin.top)
      .on("pointerdown", event => { overlay.node().setPointerCapture(event.pointerId); seek(event); })
      .on("pointermove", event => { if (event.buttons) seek(event); });
    mark();
  }

  function mark() {
    if (!run || !x) return;
    const day = Math.max(0, Math.min(x.domain()[1], (S.hour + 1 - discoveryHour(run)) / 24));
    const p = reachAt(run, S.hour);
    const km = p ? p[1] : 0;
    const px = x(day);
    future.attr("x", px).attr("y", margin.top - 4).attr("width", Math.max(0, x.range()[1] - px + 6)).attr("height", height - margin.bottom - margin.top + 4);
    dot.attr("cx", px).attr("cy", y(km));
    document.getElementById("reach-note").textContent = S.hour + 1 < discoveryHour(run) ? "not yet discovered"
      : p ? `${fmtInt(km)} km ${compass(p[2])} on day ${fmt1(day)}` : "no connected pixel yet";
  }

  return { draw, mark };
}

/* ---------- state changes ---------- */

let tod, reach;

function renderHourAll() {
  map.renderHour();
  timeline.movePlayhead();
  updateReadout();
  updateFireList();
  tod.mark();
  reach.mark();
  writeHash();
}

function renderScopeAll({ animate = false } = {}) {
  updateScopeText();
  map.selectionChanged();
  timeline.draw({ animate });
  tod.draw();
  reach.draw();
  renderHourAll();
}

function setHour(h) {
  h = clampHour(Math.round(h));
  if (h === S.hour) return;
  S.hour = h;
  renderHourAll();
}

function setWindow(w, { animate = true } = {}) {
  const same = (!w && !S.window) || (w && S.window && w[0] === S.window[0] && w[1] === S.window[1]);
  if (same) return;
  S.window = w;
  S.hour = clampHour(S.hour);
  map.paintScar();
  drawLegend();
  timeline.draw({ animate });
  tod.draw();
  renderHourAll();
}

function setScope(scope, { fly = true } = {}) {
  S.scope = scope;
  if (scope.type !== "all" && S.window) {
    // A window with nothing in it for this selection would show an empty chart, so open it up.
    const any = rowsInWindow().some(d => d.n > 0);
    if (!any) { S.window = null; map.paintScar(); drawLegend(); }
  }
  S.hour = clampHour(S.hour);
  if (fly && scope.type !== "region") map.flyTo();
  renderScopeAll({ animate: true });
}

function setView(view) {
  S.view = view;
  setRadio("#view-toggle", "view", view);
  d3.select("#trail-toggle").style("opacity", view === "power" ? null : 0.45)
    .attr("title", view === "power" ? null : "Afterglow applies to the Power now view");
  map.paintScar();
  drawLegend();
  map.renderHour();
  writeHash();
}

function setMeasure(measure) {
  S.measure = measure;
  setRadio("#measure-toggle", "measure", measure);
  document.getElementById("mode-toggle").hidden = measure !== "power";
  timeline.draw({ animate: true });
  writeHash();
}

function setSelecting(on) {
  S.selecting = on;
  document.getElementById("select-area").setAttribute("aria-pressed", String(on));
  document.getElementById("map").classList.toggle("selecting", on);
}

function setRadio(group, attr, value) {
  d3.selectAll(`${group} button`).attr("aria-checked", function () { return String(this.dataset[attr]) === String(value); });
}

function clearMoment() {
  S.moment = null;
  d3.selectAll("#moments button").attr("aria-pressed", "false");
  document.getElementById("moment-caption").textContent = "";
}

/* ---------- guided moments, computed from the data ---------- */

function buildMoments() {
  const all = seriesById.get("all").hours;
  const clampWin = (a, b) => [Math.max(0, Math.round(a)), Math.min(totalHours, Math.round(b))];
  const peak = d3.greatest(all, d => d.filled);
  const fast = runs[0];
  const fastEnd = Math.round(discoveryHour(fast) + fast.fastest.hour);
  const busy = busiestWindow(all);
  const big = d3.greatest(runs, r => r.acres);
  const bigStart = Math.floor(discoveryHour(big));
  const busyShare = d3.sum(all.slice(...busy), d => d.filled) / d3.sum(all, d => d.filled);

  const moments = [
    {
      label: "The peak hour", scope: { type: "all" }, window: clampWin(peak.i - 36, peak.i + 36), hour: peak.i, view: "power", play: false,
      caption: `The season peaked at ${hourStamp(peak.i)} solar time, when fires across the West put out ${fmtPower(peak.filled)}. Zoom in to see which fronts were hottest.`,
    },
    {
      label: `${fast.name}'s fastest run`, scope: { type: "fire", id: fast.id }, window: clampWin(fastEnd - 30, fastEnd + 18), hour: fastEnd - 8, view: "power", play: true, speed: 6,
      caption: `${fast.name} pushed its front ${fmtInt(fast.fastest.km)} km in six hours, ${fmtPct(fast.fastest.km / fast.farthest)} of the ${fmtInt(fast.farthest)} km it ever reached from its origin. Watch the dashed ring jump.`,
    },
    {
      label: "The busiest three days", scope: { type: "all" }, window: busy, hour: busy[0], view: "arrival", play: true, speed: 6,
      caption: `${windowLabelFor(busy)} produced ${fmtPct(busyShare)} of the whole period's fire power. Colour shows when each pixel first burned inside these three days; grey ground was already burnt.`,
    },
    {
      label: `${big.name}: first four days`, scope: { type: "fire", id: big.id }, window: clampWin(bigStart, bigStart + 96), hour: bigStart, view: "arrival", play: true, speed: 6,
      caption: `${big.name} became the largest fire of the period at ${fmtInt(big.acres)} acres. Its first four days show which way it ran: follow the colour from purple to yellow.`,
    },
  ];

  d3.select("#moments").selectAll("button").data(moments).join("button")
    .attr("type", "button").attr("class", "chip").attr("aria-pressed", "false").text(d => d.label)
    .on("click", function (_, d) {
      player.stop();
      S.window = null;
      S.scope = d.scope;
      S.window = d.window;
      S.hour = clampHour(d.hour);
      if (d.speed) { S.speed = d.speed; setRadio("#speed-toggle", "speed", d.speed); }
      S.view = d.view;
      setRadio("#view-toggle", "view", d.view);
      map.paintScar();
      drawLegend();
      map.flyTo();
      renderScopeAll({ animate: true });
      S.moment = d.label;
      d3.selectAll("#moments button").attr("aria-pressed", "false");
      d3.select(this).attr("aria-pressed", "true");
      document.getElementById("moment-caption").textContent = d.caption;
      if (d.play && !REDUCED_MOTION) setTimeout(() => player.play(), 950);
    });
}

function windowLabelFor([a, b]) {
  return `${fmtDay(hourDate(a))} to ${fmtDay(hourDate(b - 1))}`;
}

/* ---------- URL hash ---------- */

let hashTimer = null;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (S.scope.type === "fire") p.set("f", S.scope.id);
    if (S.scope.type === "region") p.set("r", S.scope.geo.flat().join(","));
    if (S.window) p.set("w", S.window.join("-"));
    p.set("h", S.hour);
    if (S.view !== "power") p.set("v", S.view);
    if (S.measure !== "power") p.set("m", S.measure);
    if (S.mode !== "filled") p.set("p", S.mode);
    if (S.trail !== 6) p.set("t", S.trail);
    history.replaceState(null, "", `#${p}`);
  }, 250);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const f = p.get("f");
  if (f && runById(f)) S.scope = { type: "fire", id: f };
  const r = (p.get("r") || "").split(",").map(Number);
  if (r.length === 4 && r.every(Number.isFinite)) S.scope = { type: "region", geo: [[r[0], r[1]], [r[2], r[3]]] };
  const w = (p.get("w") || "").split("-").map(Number);
  if (w.length === 2 && w.every(Number.isInteger) && w[0] >= 0 && w[1] <= totalHours && w[1] - w[0] >= 2) S.window = w;
  if (["power", "arrival", "duration"].includes(p.get("v"))) S.view = p.get("v");
  if (MEASURES[p.get("m")]) S.measure = p.get("m");
  if (p.get("p") === "reported") S.mode = "reported";
  if (["0", "6", "24"].includes(p.get("t"))) S.trail = +p.get("t");
  const h = Number(p.get("h"));
  if (p.has("h") && Number.isInteger(h) && h >= 0 && h < totalHours) S.hour = clampHour(h);
}

/* ---------- controls ---------- */

function bindControls() {
  d3.selectAll("#view-toggle button").on("click", e => setView(e.currentTarget.dataset.view));
  d3.selectAll("#measure-toggle button").on("click", e => setMeasure(e.currentTarget.dataset.measure));
  d3.selectAll("#mode-toggle button").on("click", e => {
    S.mode = e.currentTarget.dataset.mode;
    setRadio("#mode-toggle", "mode", S.mode);
    timeline.draw({ animate: true });
    writeHash();
  });
  d3.selectAll("#trail-toggle button").on("click", e => {
    S.trail = +e.currentTarget.dataset.trail;
    setRadio("#trail-toggle", "trail", S.trail);
    map.renderHour();
    writeHash();
  });
  d3.selectAll("#speed-toggle button").on("click", e => {
    S.speed = +e.currentTarget.dataset.speed;
    setRadio("#speed-toggle", "speed", S.speed);
  });
  d3.select("#select-area").on("click", () => setSelecting(!S.selecting));
  d3.select("#scope-clear").on("click", () => { clearMoment(); setScope({ type: "all" }); });
  d3.select("#fire-sort").on("change", e => { S.sort = e.target.value; sortFireList(); });
  d3.select("#win-busiest").on("click", () => { clearMoment(); setWindow(busiestWindow(scopeSeries())); });
  d3.select("#win-reset").on("click", () => { clearMoment(); setWindow(null); });

  document.addEventListener("keydown", event => {
    const tag = event.target.tagName;
    if (event.metaKey || event.ctrlKey || event.altKey || tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
    const step = event.shiftKey ? 24 : 1;
    if (event.key === " " && tag !== "BUTTON") { event.preventDefault(); player.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); player.stop(); setHour(S.hour + step); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); player.stop(); setHour(S.hour - step); }
    else if (event.key === "Escape") {
      if (S.selecting) setSelecting(false);
      else if (S.scope.type !== "all") { clearMoment(); setScope({ type: "all" }); }
    }
    else if (event.key === "+" || event.key === "=") map.zoomBy(1.8);
    else if (event.key === "-") map.zoomBy(1 / 1.8);
    else if (event.key === "1") setView("power");
    else if (event.key === "2") setView("arrival");
    else if (event.key === "3") setView("duration");
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      seriesCache.key = null;
      map.layout();
      map.selectionChanged();
      timeline.draw();
      tod.draw();
      reach.draw();
    }, 150);
  });
}

function writeNotes() {
  const fmtLong = d3.utcFormat("%B %-d");
  document.getElementById("period").textContent = `${fmtLong(new Date(meta.start))} and ${fmtLong(new Date(meta.end))}, ${meta.end.slice(0, 4)}`;
  document.getElementById("method-note").innerHTML =
    `Data: NOAA ${meta.satellite} ${meta.product} fire detections, one scan every 5 minutes, ${meta.start} to ${meta.end}, inside the dashed study area. ` +
    `${fmtInt(meta.scans)} scans gave ${fmtInt(meta.rawPixels)} fire pixels; ${fmtInt(meta.keptPixels)} remain after dropping pixels not seen again within two hours. ` +
    `Times are local solar time (UTC + longitude / 15), about 1 h 20 min behind PDT at 120°W. ` +
    `${fmtPct(meta.noFrpShare)} of fire pixels have no power value, mostly because of a daytime cloud flag; "gap-filled" gives each of those the mean power of measured pixels in the same half-degree cell and hour, and map colour only ever shows measured power. ` +
    `Fire outlines and origins are NIFC final perimeters, used to name pixels and measure distance from origin; a pixel counts toward that distance once it lies within 6 km of the fire's connected footprint. ` +
    `Smoke and cloud hide fire from the satellite, so a quiet hour is not always a calm one. ` +
    `<a href="explore.html">See the six exploratory graphs that led to this design.</a>`;
}

async function init() {
  let raw, rawPixels;
  try {
    [raw, rawPixels, states, context] = await Promise.all([
      d3.json("data/fires.json"), d3.json("data/pixels.json"), d3.json("data/states.geojson"), d3.json("data/context.json"),
    ]);
  } catch (err) {
    const p = document.createElement("p");
    p.className = "load-error";
    p.textContent = "Could not load the files in data/. Open this page through a local server, not as a file.";
    document.querySelector("main").prepend(p);
    return;
  }
  prepareData(raw);
  pixelData = preparePixels(rawPixels);
  indexPixels();
  for (const d of context) {
    d.geo = rewind(d.geometry);
    const run = runs.find(r => r.name === d.name);
    d.runId = run ? run.id : null;
  }
  S.hour = d3.greatest(seriesById.get("all").hours, d => d.filled).i;
  readHash();
  S.hour = clampHour(S.hour);

  writeNotes();
  map = createMap();
  timeline = createTimeline();
  player = createPlayer();
  tod = createTod();
  reach = createReach();
  buildFireList();
  buildMoments();
  bindControls();

  setRadio("#view-toggle", "view", S.view);
  setRadio("#measure-toggle", "measure", S.measure);
  setRadio("#mode-toggle", "mode", S.mode);
  setRadio("#trail-toggle", "trail", S.trail);
  document.getElementById("mode-toggle").hidden = S.measure !== "power";
  d3.select("#trail-toggle").style("opacity", S.view === "power" ? null : 0.45);

  drawLegend();
  map.layout();
  renderScopeAll();
}

init();
