#!/usr/bin/env python3
"""Write data/context.json: a simplified outline of every NIFC perimeter, for map context.

The explorer draws these as thin outlines so fires outside the nine attributed ones
still have a name and a size. Input is data/perimeters.geojson (see README).
"""
import argparse
import json

import pandas as pd
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union

SIMPLIFY_DEG = 0.004  # about 400 m


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--perimeters", default="data/perimeters.geojson")
    ap.add_argument("--out", default="data/context.json")
    args = ap.parse_args()

    by_name = {}
    for f in json.load(open(args.perimeters))["features"]:
        by_name.setdefault(f["properties"]["poly_IncidentName"], []).append(f)

    out = []
    for name, feats in by_name.items():
        p = max(feats, key=lambda f: f["properties"]["poly_GISAcres"] or 0)["properties"]
        geom = unary_union([shape(f["geometry"]).buffer(0) for f in feats])
        outline = shapely.set_precision(shapely.simplify(geom, SIMPLIFY_DEG), 1e-4)
        discovered = pd.to_datetime(p["attr_FireDiscoveryDateTime"], unit="ms", utc=True)
        out.append(dict(
            name=name.title() if name.isupper() else name,
            state=(p.get("attr_POOState") or "").replace("US-", ""),
            acres=round(sum(f["properties"]["poly_GISAcres"] or 0 for f in feats)),
            cause=p.get("attr_FireCause"),
            discovered=discovered.strftime("%Y-%m-%dT%H:%MZ"),
            origin=[round(p["attr_InitialLongitude"], 4), round(p["attr_InitialLatitude"], 4)],
            geometry=json.loads(shapely.to_geojson(outline))))
    out.sort(key=lambda r: -r["acres"])
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(out)} perimeters -> {args.out}")


if __name__ == "__main__":
    main()
