// Street furniture placed automatically from the road shapes (OpenStreetMap in Japan has very few utility poles,
// street lamps or signals). The same rules run in the 3D view and in the export, so Blender gets the poles where the
// browser showed them.
//   Positions do not depend on how a road is split into pieces: along each straight stretch, things are placed where
//   a fixed world grid crosses the road (so two data sources with the same road give the same spots).
import * as G from "./geo.js?v=202611200022";
import { photoTrees } from "./phototrees.js?v=202611200022";

// road kinds (OpenMapTiles classes). w = carriageway width (m), walk = sidewalk on each side, rank = importance
export const ROAD = {
  motorway: {w: 14, walk: 0, rank: 6},
  trunk: {w: 13, walk: 3, rank: 5, lamps: 2},
  primary: {w: 11, walk: 3, rank: 4, lamps: 2},
  secondary: {w: 8.5, walk: 2.5, rank: 3, lamps: 2},
  busway: {w: 7, walk: 2, rank: 2, lamps: 1},
  tertiary: {w: 7, walk: 2, rank: 2, poles: true, lamps: 1},
  minor: {w: 4.5, walk: 0, rank: 1, poles: true},
  service: {w: 3.5, walk: 0, rank: 0.5},
  track: {w: 3, walk: 0, rank: 0},
  path: {w: 1.6, walk: 0, rank: -1},
};
export const POLE_STEP = 30, LAMP_STEP = 34;

// OpenStreetMap highway=* -> class above
export function classOfOsm(hw) {
  if (!hw) return null;
  const b = String(hw).replace(/_link$/, "");
  if (ROAD[b] && b !== "minor" && b !== "path") return b;
  if (/^(residential|unclassified|living_street|road)$/.test(b)) return "minor";
  if (/^(footway|path|pedestrian|cycleway|steps|bridleway|corridor)$/.test(b)) return "path";
  return null;
}

// world grid for placement (only the phase matters, so a rough fixed scale is fine)
const GX = 90500, GY = 110950;
const keyOf = p => p[0].toFixed(6) + "," + p[1].toFixed(6);
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
const deg = r => r * 180 / Math.PI;

// roads: [{cls, pts: [[lon,lat],...], brunnel}], osm: {signals, lamps, poles} as [[lon,lat],...]
// -> {poles: [{p, a}], wires: [[p, p]], lamps: [{p, a}], signals: [{p, a, arm}], crossings: [{p, a, w, d}]}
// a = angle in degrees, east = 0, counter-clockwise (poles: along the road; lamps: the arm points this way;
// signals: the lights face this way and the arm reaches to the left of it; crossings: the road direction)
export function autoProps(roads, osm = {}) {
  roads = roads.filter(r => ROAD[r.cls] && r.pts.length > 1 && r.brunnel !== "tunnel");
  if (!roads.length) return {poles: [], wires: [], lamps: [], signals: [], crossings: [], junctions: []};
  // Everything is worked out from each road's own coordinates (no shared local origin), so the result for a road
  // does not depend on which other roads were passed in.
  const move = (p, u, m) => G.offset(p, u[0] * m, u[1] * m);

  // ---- junctions: points where 3 or more distinct pieces of drivable road meet
  const seg = new Set(), legs = new Map();
  for (const r of roads) {
    if (ROAD[r.cls].rank < 0.5) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = keyOf(r.pts[i - 1]), b = keyOf(r.pts[i]);
      if (a === b) continue;
      const k = a < b ? a + "|" + b : b + "|" + a;
      if (seg.has(k)) continue; seg.add(k);
      for (const [v, from, to] of [[a, r.pts[i - 1], r.pts[i]], [b, r.pts[i], r.pts[i - 1]]]) {
        if (!legs.has(v)) legs.set(v, {p: from, legs: []});
        const d = G.delta(from, to), L = Math.hypot(d[0], d[1]);
        legs.get(v).legs.push({u: [d[0] / L, d[1] / L], cls: r.cls});
      }
    }
  }
  const osmSig = osm.signals || [];
  const junctions = [];
  for (const j of legs.values()) {
    const ls = [];
    for (const l of j.legs) if (!ls.some(m => m.u[0] * l.u[0] + m.u[1] * l.u[1] > 0.985)) ls.push(l);      // same direction twice
    if (ls.length < 3) continue;
    const hw = Math.max(...ls.map(l => ROAD[l.cls].w / 2));
    const major = ls.filter(l => ROAD[l.cls].rank >= 2).length;
    const sig = (major >= 2 && ls.some(l => ROAD[l.cls].rank >= 3)) || osmSig.some(s => G.dist(s, j.p) < 22);
    junctions.push({p: j.p, legs: ls, hw, sig});
  }
  const nearJunction = (p, extra) => junctions.some(j => Math.abs(j.p[0] - p[0]) < 0.001 && Math.abs(j.p[1] - p[1]) < 0.001 && G.dist(j.p, p) < j.hw + extra);

  // ---- signals and crossings at signalled junctions (Japan drives on the left)
  const signals = [], crossings = [];
  for (const j of junctions) {
    if (!j.sig) continue;
    const ls = j.legs.slice().sort((a, b) => ROAD[b.cls].w - ROAD[a.cls].w).slice(0, 4);
    for (const l of ls) {
      const R = ROAD[l.cls], u = l.u, left = [u[1], -u[0]];             // left of a car driving in, toward the junction
      signals.push({p: move(move(j.p, u, j.hw + 2.5), left, R.w / 2 + 0.9), a: deg(Math.atan2(u[1], u[0])), arm: Math.min(R.w / 2, 4.5)});
      crossings.push({p: move(j.p, u, j.hw + 3), a: deg(Math.atan2(u[1], u[0])), w: R.w, d: 4});
    }
  }

  // ---- poles (with wires) and lamps along the roads
  const osmPoles = osm.poles || [], osmLamps = osm.lamps || [];
  const near = (list, q, d) => list.some(s => G.dist(s, q) < d);
  const poles = [], wires = [], lamps = [], seen = new Set();
  const once = (q, tag) => { const k = tag + Math.round(q[0] * 2e5) + "," + Math.round(q[1] * 2e5); if (seen.has(k)) return false; seen.add(k); return true; };
  for (const r of roads) {
    const R = ROAD[r.cls];
    if (r.brunnel === "bridge" || (!R.poles && !R.lamps)) continue;
    let lastPole = null, lastLamp = null;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i], d = G.delta(a, b), L = Math.hypot(d[0], d[1]);
      if (L < 0.5) continue;
      let n = [-d[1] / L, d[0] / L];
      if (n[0] * 0.93 + n[1] * 0.37 < 0) n = [-n[0], -n[1]];                    // the same side whichever way the road was drawn
      const ga = [a[0] * GX, a[1] * GY], gb = [b[0] * GX, b[1] * GY];
      const ax = Math.abs(gb[0] - ga[0]) >= Math.abs(gb[1] - ga[1]) ? 0 : 1;
      const g0 = ga[ax], g1 = gb[ax], span = Math.abs(g1 - g0);
      const place = (step, phase, fn) => {
        const S = step * span / L, lo = Math.min(g0, g1), hi = Math.max(g0, g1);
        const ts = [];
        for (let k = Math.ceil((lo - phase * S) / S); k * S + phase * S <= hi; k++) ts.push([(k * S + phase * S - g0) / (g1 - g0), k]);
        ts.sort((x, y) => x[0] - y[0]);
        for (const [t, k] of ts) fn([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], k);
      };
      if (R.poles) place(POLE_STEP, 0, (c, k) => {
        const q = move(c, n, R.w / 2 + R.walk + 0.35);
        if (nearJunction(c, 3) || near(osmPoles, q, 8)) return;
        if (lastPole && G.dist(lastPole, q) < POLE_STEP * 0.35) return;      // where two straight parts meet
        if (!once(q, "p")) { lastPole = q; return; }
        if (lastPole && G.dist(lastPole, q) < POLE_STEP * 1.6) wires.push([lastPole, q]);
        poles.push({p: q, a: deg(Math.atan2(d[1], d[0]))});
        lastPole = q;
      });
      if (R.lamps) place(LAMP_STEP, 0.5, (c, k) => {
        const side = R.lamps === 2 ? (k % 2 ? 1 : -1) : (R.poles ? -1 : 1);
        const nn = [n[0] * side, n[1] * side];
        const q = move(c, nn, R.w / 2 + 0.5);
        if (nearJunction(c, 2) || near(osmLamps, q, 8)) return;
        if (lastLamp && G.dist(lastLamp, q) < LAMP_STEP * 0.35) return;
        lastLamp = q;
        if (!once(q, "l")) return;
        lamps.push({p: q, a: deg(Math.atan2(-nn[1], -nn[0]))});
      });
    }
  }
  for (const q of osmPoles) poles.push({p: q, a: 0, osm: true});
  for (const q of osmLamps) lamps.push({p: q, a: 0, osm: true});
  return {poles, wires, lamps, signals, crossings, junctions: junctions.map(j => ({p: j.p, hw: j.hw, sig: j.sig}))};
}

// Trees inside woods and parks, on a jittered world grid (the same spots every time)
export function greenTrees(green, keep, max = 6000) {
  const out = [], seen = new Set();
  for (const g of green) {
    if (g.kind !== "wood" && g.kind !== "park") continue;
    const step = g.kind === "wood" ? 7 : 13;
    const bb = G.bboxOf(g.rings[0]);
    const sx = step / GX, sy = step / GY;                                   // grid step in degrees (about step metres)
    const i0 = Math.floor(bb[0] / sx), i1 = Math.ceil(bb[2] / sx), j0 = Math.floor(bb[1] / sy), j1 = Math.ceil(bb[3] / sy);
    if ((i1 - i0) * (j1 - j0) > 40000) continue;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const p = [(i + 0.15 + 0.7 * hash(i, j)) * sx, (j + 0.15 + 0.7 * hash(j, i)) * sy];
      if (!keep(p) || !G.pointInRing(p, g.rings[0]) || g.rings.slice(1).some(h => G.pointInRing(p, h))) continue;
      const k = step + ":" + i + "," + j; if (seen.has(k)) continue; seen.add(k);
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}
// Trees along tree rows (OSM natural=tree_row), every 7 m
export function rowTrees(lines) {
  const out = [];
  for (const line of lines) {
    let carry = 0;
    for (let i = 1; i < line.length; i++) {
      const d = G.delta(line[i - 1], line[i]), L = Math.hypot(d[0], d[1]);
      for (let s = carry; s < L; s += 7) out.push(G.offset(line[i - 1], d[0] * s / L, d[1] * s / L));
      carry = ((carry - L) % 7 + 7) % 7;
    }
  }
  return out;
}

// ---- all the trees for an area, the same in the 3D view and in the export
//   osm trees and tree rows (OpenStreetMap), woods filled every 7 m, and trees read from the aerial photo
//   (lib/phototrees.js). Parks are filled every 13 m only when the photo could not be read; otherwise the photo
//   decides where the trees in a park stand (lawns and squares stay open).
//   o: {osmTrees, rows, green, roads, inBuilding(p), mask (photoMask or null), bbox, keep(p), max}
//   -> [{p: [lon, lat], src: "osm" | "row" | "wood" | "park" | "photo", r?: crown radius m}]
export function treesFor(o) {
  const keep = o.keep || (() => true), max = o.max || 6000, out = [];
  for (const p of o.osmTrees || []) if (keep(p)) out.push({p, src: "osm"});
  for (const p of rowTrees(o.rows || [])) if (keep(p)) out.push({p, src: "row"});
  const usePhoto = !!(o.mask && o.mask.ok);
  for (const kind of usePhoto ? ["wood"] : ["wood", "park"])
    for (const p of greenTrees((o.green || []).filter(g => g.kind === kind), keep, max)) out.push({p, src: kind});
  if (!usePhoto || out.length >= max) return out.slice(0, max);

  // where the photo trees may not stand: buildings, roadways, woods (already filled), water, next to another tree
  const cell = 0.0004, grid = new Map(), put = (bb, item) => {
    for (let x = Math.floor(bb[0] / cell); x <= Math.floor(bb[2] / cell); x++)
      for (let y = Math.floor(bb[1] / cell); y <= Math.floor(bb[3] / cell); y++) {
        const k = x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(item);
      }
  };
  for (const r of o.roads || []) {
    const R = ROAD[r.cls]; if (!R || R.rank < 0.5 || r.brunnel === "tunnel") continue;
    const hw = R.w / 2, pad = hw / 90000;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      put([Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad], {seg: [a, b], hw});
    }
  }
  for (const g of o.green || []) if (g.kind === "wood" || g.kind === "water") put(G.bboxOf(g.rings[0]), {area: g});
  for (const t of out) put([t.p[0], t.p[1], t.p[0], t.p[1]], {tree: t.p});
  const blocked = p => {
    for (const it of grid.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell)) || []) {
      if (it.seg) {
        const [a, b] = it.seg, d = G.delta(a, b), q = G.delta(a, p), L2 = d[0] * d[0] + d[1] * d[1];
        const t = L2 ? Math.max(0, Math.min(1, (q[0] * d[0] + q[1] * d[1]) / L2)) : 0;
        if (Math.hypot(q[0] - d[0] * t, q[1] - d[1] * t) < it.hw) return true;
      } else if (it.area) {
        if (G.pointInRing(p, it.area.rings[0]) && !it.area.rings.slice(1).some(h => G.pointInRing(p, h))) return true;
      } else if (G.dist(it.tree, p) < 3) return true;
    }
    return o.inBuilding ? !!o.inBuilding(p) : false;
  };
  for (const [lon, lat, r] of photoTrees(o.mask, o.bbox, p => keep(p) && !blocked(p), max - out.length))
    out.push({p: [lon, lat], src: "photo", r});
  return out;
}
