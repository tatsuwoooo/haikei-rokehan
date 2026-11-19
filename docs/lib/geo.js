// Geography helpers: local meters, Japan plane rectangular coordinates (JGD2011), standard area mesh codes,
// and small 2D geometry (point in polygon, area, centroid, oriented box).

const D2R = Math.PI / 180;

// ------------------------------------------------------------------ local meters (for drawing / editing)
// Equirectangular around a reference point: good to a few cm over a few km, used only for editing shapes.
export function mPerDeg(lat) {
  const p = lat * D2R;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}
export function offset([lon, lat], dx, dy) {          // move by dx m east, dy m north
  const k = mPerDeg(lat);
  return [lon + dx / k.lon, lat + dy / k.lat];
}
export function delta([lon0, lat0], [lon, lat]) {      // meters east/north from a to b
  const k = mPerDeg((lat0 + lat) / 2);
  return [(lon - lon0) * k.lon, (lat - lat0) * k.lat];
}
export const dist = (a, b) => Math.hypot(...delta(a, b));

// ------------------------------------------------------------------ plane rectangular coordinates
// 19 zones of the Japan Plane Rectangular CS: origin [lat, lon] in degrees.
export const ZONES = {
  1: [33, 129.5], 2: [33, 131], 3: [36, 132 + 10 / 60], 4: [33, 133.5], 5: [36, 134 + 20 / 60],
  6: [36, 136], 7: [36, 137 + 10 / 60], 8: [36, 138.5], 9: [36, 139 + 50 / 60], 10: [40, 140 + 50 / 60],
  11: [44, 140.25], 12: [44, 142.25], 13: [44, 144.25], 14: [26, 142], 15: [26, 127.5], 16: [26, 124],
  17: [26, 131], 18: [20, 136], 19: [26, 154],
};
const PREF_ZONE = {  // JIS prefecture code -> zone (special cases handled in zoneFor)
  2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 9, 8: 9, 9: 9, 10: 9, 11: 9, 12: 9, 13: 9, 14: 9, 15: 8, 16: 7, 17: 7,
  18: 6, 19: 8, 20: 8, 21: 7, 22: 8, 23: 7, 24: 6, 25: 6, 26: 6, 27: 6, 28: 5, 29: 6, 30: 6, 31: 5, 32: 3,
  33: 5, 34: 3, 35: 3, 36: 4, 37: 4, 38: 4, 39: 4, 40: 2, 41: 2, 42: 1, 43: 2, 44: 2, 45: 2, 46: 2, 47: 15,
};
// Zone from the prefecture (JIS code, or null when unknown) and the position.
export function zoneFor(pref, lat, lon) {
  if (pref === 1) return lon < 141.0 ? 11 : lon < 143.0 ? 12 : 13;           // Hokkaido (approximate split)
  if (pref === 13 && lat < 28) return lon > 150 ? 19 : 14;                    // Ogasawara
  if (pref === 46 && lon < 130.0) return 1;                                    // western Kagoshima islands
  if (pref === 47) return lon < 126 ? 16 : lon > 130.5 ? 17 : 15;             // Okinawa
  if (PREF_ZONE[pref]) return PREF_ZONE[pref];
  // unknown prefecture: nearest zone origin by longitude among mainland zones
  let best = 9, bd = 1e9;
  for (const z of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    const d = Math.abs(ZONES[z][1] - lon) + Math.abs(ZONES[z][0] - lat) * 0.2;
    if (d < bd) { bd = d; best = z; }
  }
  return best;
}

// Gauss-Krüger (Krüger n-series), GRS80, scale 0.9999 — the same method as the GSI calculation.
const a = 6378137, F = 298.257222101, m0 = 0.9999;
const n = 1 / (2 * F - 1), e = 2 * Math.sqrt(n) / (1 + n);
const A_ = m0 * a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64);
const AL = [
  n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16 + 41 * n ** 4 / 180 - 127 * n ** 5 / 288,
  13 * n ** 2 / 48 - 3 * n ** 3 / 5 + 557 * n ** 4 / 1440 + 281 * n ** 5 / 630,
  61 * n ** 3 / 240 - 103 * n ** 4 / 140 + 15061 * n ** 5 / 26880,
  49561 * n ** 4 / 161280 - 179 * n ** 5 / 168,
  34729 * n ** 5 / 80640,
];
function tm(lat, lon, lon0) {
  const p = lat * D2R, dl = (lon - lon0) * D2R;
  const t = Math.sinh(Math.atanh(Math.sin(p)) - e * Math.atanh(e * Math.sin(p)));
  const tb = Math.sqrt(1 + t * t);
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / tb);
  let x = xi, y = eta;
  for (let j = 1; j <= 5; j++) {
    x += AL[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += AL[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return [A_ * x, A_ * y];                     // [northing from equator, easting from central meridian]
}
// lon/lat -> [east, north] meters in the zone (Japanese survey X is north and Y is east; we return east first).
export function makePlane(zone) {
  const [lat0, lon0] = ZONES[zone];
  const x0 = tm(lat0, lon0, lon0)[0];
  return (lon, lat) => { const [x, y] = tm(lat, lon, lon0); return [y, x - x0]; };
}

// ------------------------------------------------------------------ standard area mesh (JIS X 0410)
// level 3 = 3rd mesh (30" x 45", about 1 km), level 4 = 1/2 mesh (about 500 m).
const MESH = { 3: [30 / 3600, 45 / 3600], 4: [15 / 3600, 22.5 / 3600] };
export function meshCode(lat, lon, level) {
  const p = Math.floor(lat * 1.5), u = Math.floor(lon - 100);
  const a1 = lat * 1.5 - p, f1 = lon - 100 - u;
  const q = Math.floor(a1 * 8), v = Math.floor(f1 * 8);
  const a2 = a1 * 8 - q, f2 = f1 * 8 - v;
  const r = Math.floor(a2 * 10), w = Math.floor(f2 * 10);
  let code = `${p}${u}${q}${v}${r}${w}`;
  if (level === 4) {
    const a3 = a2 * 10 - r, f3 = f2 * 10 - w;
    code += 1 + (a3 >= 0.5 ? 2 : 0) + (f3 >= 0.5 ? 1 : 0);
  }
  return code;
}
export function meshBounds(code) {            // [west, south, east, north]
  const p = +code.slice(0, 2), u = +code.slice(2, 4), q = +code[4], v = +code[5], r = +code[6], w = +code[7];
  let s = p / 1.5 + q / 12 + r / 120, we = 100 + u + v / 8 + w / 80;
  let [dl, dn] = [45 / 3600, 30 / 3600];
  if (code.length >= 9) {
    const m = +code[8] - 1;
    dl /= 2; dn /= 2;
    if (m & 2) s += dn;
    if (m & 1) we += dl;
  }
  return [we, s, we + dl, s + dn];
}
// Mesh cells (codes) overlapping a lon/lat box.
export function meshCells([w, s, e, nn], level) {
  const [dn, dl] = MESH[level], out = [];
  const lat0 = Math.floor(s / dn) * dn, lon0 = Math.floor(w / dl) * dl;
  for (let lat = lat0; lat < nn; lat += dn)
    for (let lon = lon0; lon < e; lon += dl)
      out.push(meshCode(lat + dn / 2, lon + dl / 2, level));
  return [...new Set(out)];
}
export const meshStep = level => MESH[level];          // [dLat, dLon]

// ------------------------------------------------------------------ 2D geometry (any units, ring = [[x,y],...])
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function ringArea(ring) {
  const [ox, oy] = ring[0];
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ox + ring[i][0] - ox) * (ring[j][1] - ring[i][1]);
  return Math.abs(s / 2);
}
export function ringCentroid(ring) {
  // Work relative to the first vertex: with lon/lat (139.7, 35.6) the cross products are huge and nearly cancel,
  // which would move the centroid by hundreds of metres.
  const [ox, oy] = ring[0];
  let ax = 0, ay = 0, aa = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xj = ring[j][0] - ox, yj = ring[j][1] - oy, xi = ring[i][0] - ox, yi = ring[i][1] - oy;
    const c = xj * yi - xi * yj;
    aa += c; ax += (xj + xi) * c; ay += (yj + yi) * c;
  }
  if (Math.abs(aa) < 1e-20) {
    const m = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  return [ox + ax / (3 * aa), oy + ay / (3 * aa)];
}
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// Smallest box around a ring: [cx, cy, width, depth, angle in degrees CCW from +x].
export function orientedBox(ring) {
  const h = hull(ring);
  if (h.length < 3) { const c = ringCentroid(ring); return [c[0], c[1], 1, 1, 0]; }
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [x1, y1] = h[i], [x2, y2] = h[(i + 1) % h.length];
    const ang = Math.atan2(y2 - y1, x2 - x1), c = Math.cos(ang), s = Math.sin(ang);
    let a0 = 1e18, a1 = -1e18, b0 = 1e18, b1 = -1e18;
    for (const [x, y] of h) { const u = x * c + y * s, v = -x * s + y * c; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const u = (a0 + a1) / 2, v = (b0 + b1) / 2;
      best = {area, box: [u * c - v * s, u * s + v * c, a1 - a0, b1 - b0, ang / D2R]};
    }
  }
  return best.box;
}
export function bboxOf(pts) {
  let w = 1e18, s = 1e18, e = -1e18, nn = -1e18;
  for (const [x, y] of pts) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); nn = Math.max(nn, y); }
  return [w, s, e, nn];
}
export const boxesOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
// Does a range (closed ring) really cover part of a mesh cell [w,s,e,n]? Tests inside points only, so a range that
// just touches the cell along a grid line does not count.
export function ringTouchesBox(b, ring) {
  if (!boxesOverlap(b, bboxOf(ring))) return false;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++)
    if (pointInRing([b[0] + (b[2] - b[0]) * (i + 0.5) / 6, b[1] + (b[3] - b[1]) * (j + 0.5) / 6], ring)) return true;
  const e = 1e-6;
  return ring.some(p => p[0] > b[0] + e && p[0] < b[2] - e && p[1] > b[1] + e && p[1] < b[3] - e);
}

// ------------------------------------------------------------------ web mercator tiles
export function lonLatToTile(lon, lat, z) {
  const k = 2 ** z, x = (lon + 180) / 360 * k;
  const y = (1 - Math.asinh(Math.tan(lat * D2R)) / Math.PI) / 2 * k;
  return [x, y];
}
export function tileToLonLat(x, y, z) {
  const k = 2 ** z;
  return [x / k * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / k))) / D2R];
}
export function tilesFor([w, s, e, nn], z) {
  const [x0, y0] = lonLatToTile(w, nn, z), [x1, y1] = lonLatToTile(e, s, z), out = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) out.push([z, x, y]);
  return out;
}
