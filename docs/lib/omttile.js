// OpenFreeMap (OpenMapTiles) z14 tiles read directly, for the detailed view near the camera.
// Unlike map.querySourceFeatures(), this does not depend on which tiles happen to be on screen, and each feature
// is cut exactly to its tile square, so nothing is counted twice where tiles overlap.
import { decodeTile, polygons } from "./mvt.js?v=202611200145";
import * as G from "./geo.js?v=202611200145";

const cache = new Map();          // url -> Promise<{roads, buildings, green}>

// Liang–Barsky: cut a line to the square [0, ext]
function clipLine(line, ext) {
  const out = []; let cur = null;
  for (let i = 1; i < line.length; i++) {
    let [x0, y0] = line[i - 1], [x1, y1] = line[i];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0], [dx, ext - x0], [-dy, y0], [dy, ext - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { cur = null; continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy], b = [x0 + t1 * dx, y0 + t1 * dy];
    if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return out.filter(l => l.length > 1);
}

export function omtTile(tpl, z, x, y) {
  const url = tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  if (!cache.has(url)) cache.set(url, (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const L = decodeTile(new Uint8Array(await r.arrayBuffer()));
      const ll = ext => ([px, py]) => G.tileToLonLat(x + px / ext, y + py / ext, z);
      const roads = [], buildings = [], green = [];
      const tl = L.transportation;
      if (tl) for (const f of tl.features) {
        if (f.type !== 2) continue;
        const p = f.props;
        for (const line of f.geom) for (const part of clipLine(line, tl.extent))
          roads.push({cls: p.class, sub: p.subclass || null, brunnel: p.brunnel || null, ramp: !!p.ramp, oneway: !!p.oneway, pts: part.map(ll(tl.extent))});
      }
      const bl = L.building;
      if (bl) for (const f of bl.features) {
        if (f.type !== 3 || f.props.hide_3d) continue;
        for (const poly of polygons(f.geom)) {
          const c = G.ringCentroid(poly[0]);
          if (c[0] < 0 || c[0] >= bl.extent || c[1] < 0 || c[1] >= bl.extent) continue;       // the next tile owns it
          buildings.push({rings: poly.map(r => r.map(ll(bl.extent))), h: f.props.render_height, minH: f.props.render_min_height || 0});
        }
      }
      for (const [name, key] of [["landcover", "class"], ["park", "class"]]) {
        const lc = L[name]; if (!lc) continue;
        for (const f of lc.features) {
          if (f.type !== 3) continue;
          const cls = f.props[key], sub = f.props.subclass;
          const kind = name === "park" ? "park" : cls === "wood" ? "wood" : (cls === "grass" && /park|garden|recreation_ground/.test(sub || "")) ? "park" : null;
          if (!kind) continue;
          for (const poly of polygons(f.geom)) green.push({kind, rings: poly.map(r => r.map(ll(lc.extent)))});
        }
      }
      const wl = L.water;                                // water is coloured on the ground too
      if (wl) for (const f of wl.features) {
        if (f.type !== 3 || f.props.brunnel === "tunnel") continue;
        for (const poly of polygons(f.geom)) green.push({kind: "water", rings: poly.map(r => r.map(ll(wl.extent)))});
      }
      return {roads, buildings, green};
    } catch { cache.delete(url); return {roads: [], buildings: [], green: []}; }
  })());
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return cache.get(url);
}

export async function omtArea(tpl, bbox) {
  const parts = await Promise.all(G.tilesFor(bbox, 14).map(([z, x, y]) => omtTile(tpl, z, x, y)));
  return {roads: parts.flatMap(p => p.roads), buildings: parts.flatMap(p => p.buildings), green: parts.flatMap(p => p.green)};
}
