// Ranges the user places on the map.
//   rect:   {kind:"rect", c:[lon,lat], w, h (m), ang (deg, counter-clockwise from east)}
//   circle: {kind:"circle", c:[lon,lat], r (m)}
//   box:    {kind:"box", b:[w,s,e,n]}  -- snapped to the standard area mesh grid
// Every range also has id, name, level ("detail" | "mid" | "far" | "none").
import { offset, delta, meshBounds, meshCode, meshStep } from "./geo.js?v=202611200008";

export const LEVELS = {
  detail: {label: "詳細", color: "#f39a2b", rank: 3},
  mid: {label: "中景", color: "#3d8bff", rank: 2},
  far: {label: "板ポリ", color: "#a875ff", rank: 1},
  none: {label: "作らない", color: "#8a8c99", rank: 0},
};

const rot = (x, y, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };

export function ringOf(sh) {                       // closed ring [[lon,lat],...]
  if (sh.kind === "circle") {
    const n = 72, out = [];
    for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; out.push(offset(sh.c, sh.r * Math.cos(t), sh.r * Math.sin(t))); }
    return out;
  }
  if (sh.kind === "box") { const [w, s, e, n] = sh.b; return [[w, s], [e, s], [e, n], [w, n], [w, s]]; }
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => offset(sh.c, ...rot(u * sh.w / 2, v * sh.h / 2, sh.ang)));
  return [...pts, pts[0]];
}

export function bboxOfShape(sh) {
  const r = ringOf(sh);
  return [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))];
}
export const centerOf = sh => sh.kind === "box" ? [(sh.b[0] + sh.b[2]) / 2, (sh.b[1] + sh.b[3]) / 2] : sh.c;

export function sizeText(sh) {
  if (sh.kind === "circle") return `丸 r=${fmtM(sh.r)}`;
  if (sh.kind === "box") { const [w, h] = boxSize(sh); return `格子 ${fmtM(w)}×${fmtM(h)}`; }
  return `四角 ${fmtM(sh.w)}×${fmtM(sh.h)}`;
}
export const fmtM = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + "km" : Math.round(m) + "m";
export function boxSize(sh) { const [w, s, e, n] = sh.b; const d = delta([w, s], [e, n]); return [Math.abs(d[0]), Math.abs(d[1])]; }
export function areaOf(sh) {
  if (sh.kind === "circle") return Math.PI * sh.r * sh.r;
  if (sh.kind === "box") { const [w, h] = boxSize(sh); return w * h; }
  return sh.w * sh.h;
}

// Handles of a selected range: [{type, p:[lon,lat], i}]
export function handlesOf(sh) {
  if (sh.kind === "circle") return [{type: "move", p: sh.c}, {type: "radius", p: offset(sh.c, sh.r, 0)}];
  const ring = ringOf(sh).slice(0, 4), hs = ring.map((p, i) => ({type: "corner", p, i}));
  if (sh.kind === "rect") {
    hs.push({type: "rotate", p: offset(sh.c, ...rot(0, sh.h / 2 + Math.max(20, sh.h * 0.18), sh.ang))});
    hs.push({type: "move", p: sh.c});
  } else hs.push({type: "move", p: centerOf(sh)});
  return hs;
}

// Drag a handle to point p. Returns the changed shape (a copy).
export function dragHandle(sh, h, p, start, orig) {
  const s = JSON.parse(JSON.stringify(orig));
  if (h.type === "move") {
    const d = delta(start, p);
    if (s.kind === "box") {
      const [w, so] = offset([s.b[0], s.b[1]], d[0], d[1]), [e, n] = offset([s.b[2], s.b[3]], d[0], d[1]);
      s.b = snapBox([w, so, e, n], sh.gridLevel || 4, true);
    } else s.c = offset(orig.c, d[0], d[1]);
  } else if (h.type === "radius") {
    s.r = Math.max(20, Math.hypot(...delta(orig.c, p)));
  } else if (h.type === "rotate") {
    const d = delta(orig.c, p);
    s.ang = Math.round((Math.atan2(d[1], d[0]) * 180 / Math.PI - 90) * 10) / 10;
  } else if (h.type === "corner" && s.kind === "rect") {
    const ring = ringOf(orig), fixed = ring[(h.i + 2) % 4];
    const [vx, vy] = rot(...delta(fixed, p), -orig.ang);
    s.w = Math.max(20, Math.abs(vx)); s.h = Math.max(20, Math.abs(vy));
    const [cx, cy] = rot(Math.sign(vx || 1) * s.w / 2, Math.sign(vy || 1) * s.h / 2, orig.ang);
    s.c = offset(fixed, cx, cy);
  } else if (h.type === "corner" && s.kind === "box") {
    const ring = ringOf(orig), fixed = ring[(h.i + 2) % 4];
    s.b = snapBox([Math.min(fixed[0], p[0]), Math.min(fixed[1], p[1]), Math.max(fixed[0], p[0]), Math.max(fixed[1], p[1])], sh.gridLevel || 4);
  }
  return s;
}

// Snap a lon/lat box outward to whole mesh cells (or to the nearest lines when moving).
export function snapBox([w, s, e, n], level, nearest) {
  const [dn, dl] = meshStep(level), f = nearest ? Math.round : null;
  if (nearest) {
    const dw = Math.round(w / dl) * dl - w, ds = Math.round(s / dn) * dn - s;
    return [w + dw, s + ds, e + dw, n + ds];
  }
  const W = Math.floor(w / dl + 1e-9) * dl, S = Math.floor(s / dn + 1e-9) * dn;
  const E = Math.max(W + dl, Math.ceil(e / dl - 1e-9) * dl), N = Math.max(S + dn, Math.ceil(n / dn - 1e-9) * dn);
  return [W, S, E, N];
}
export function cellBox(lonlat, level) { return meshBounds(meshCode(lonlat[1], lonlat[0], level)); }

// New range drawn from a to b. bearing: map rotation, so a drawn rectangle lines up with the screen.
export function drawShape(kind, a, b, bearing, gridLevel) {
  if (kind === "circle") return {kind, c: a, r: Math.max(20, Math.hypot(...delta(a, b)))};
  if (kind === "box") return {kind, gridLevel, b: snapBox([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], gridLevel)};
  const ang = -bearing, [vx, vy] = rot(...delta(a, b), -ang);
  const w = Math.max(20, Math.abs(vx)), h = Math.max(20, Math.abs(vy));
  const [cx, cy] = rot(Math.sign(vx || 1) * w / 2, Math.sign(vy || 1) * h / 2, ang);
  return {kind: "rect", c: offset(a, cx, cy), w, h, ang: Math.round(ang * 10) / 10};
}
