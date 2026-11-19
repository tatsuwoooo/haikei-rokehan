// Trees read from the GSI aerial photo (seamlessphoto z18, about 0.5 m a pixel).
// The map data knows only a few trees in Japan (street trees, garden trees, school and shrine trees are mostly
// missing), so the photo fills them in. A pixel counts as "tree" when it is clearly green and the brightness
// around it is rough: tree crowns are lumpy with small shadows; lawns, green roofs and green paint are smooth.
// Trees are then put on a fixed world grid (every STEP m, shaken a little), where most of the ground within 2 m
// is tree. The same code runs in the 3D view and in the export, so Blender gets the trees the browser showed.
import * as G from "./geo.js?v=202611200022";

export const PHOTO_TILE = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`;
const Z = 18, N = 256;
export const PT = {exg: 4, dark: 25, bright: 160, rough: 8, step: 5, near: 2, need: 0.5};   // tuning (see classify / photoTrees)
const GX = 90500, GY = 110950;
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };

// pixels -> 1 (tree) / 0. The photo is often hazy (blue-grey), so "green" is measured against the middle of the
// tile, not as an absolute colour. Only bright-enough, not-too-bright, rough patches count.
const integ = (v, W) => {
  const S = new Float64Array(W * W);
  for (let y = 0; y < N; y++) { let a = 0; for (let x = 0; x < N; x++) { a += v[y * N + x]; S[(y + 1) * W + x + 1] = S[y * W + x + 1] + a; } }
  return S;
};
export function classify(d) {
  const lum = new Float32Array(N * N), sq = new Float32Array(N * N), ex = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    lum[i] = 0.3 * r + 0.59 * g + 0.11 * b; sq[i] = lum[i] * lum[i]; ex[i] = 2 * g - r - b;
  }
  const med = Float32Array.from(ex).sort()[N * N >> 1];
  const W = N + 1, S1 = integ(lum, W), S2 = integ(sq, W), SE = integ(ex, W);
  const box = (S, x, y, r) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(N, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(N, y + r + 1);
    return (S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const out = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const m1 = box(S1, x, y, 3);
    if (m1 < PT.dark || m1 > PT.bright) continue;
    if (box(SE, x, y, 2) - med < PT.exg) continue;
    const sd = Math.sqrt(Math.max(0, box(S2, x, y, 3) - m1 * m1));
    if (sd >= PT.rough * m1 / 100) out[y * N + x] = 1;          // roughness relative to the brightness
  }
  return out;
}

async function pixels(blob) {
  const bm = await createImageBitmap(blob);
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(N, N) : Object.assign(document.createElement("canvas"), {width: N, height: N});
  const ctx = c.getContext("2d", {willReadFrequently: true});
  ctx.drawImage(bm, 0, 0); if (bm.close) bm.close();
  return ctx.getImageData(0, 0, N, N).data;
}

const cache = new Map();          // "x/y" -> Promise<Uint8Array | null>
function maskTile(x, y) {
  const k = x + "/" + y;
  if (!cache.has(k)) cache.set(k, (async () => {
    for (let t = 0; t < 2; t++) {
      try {
        const r = await fetch(PHOTO_TILE(Z, x, y));
        if (r.status === 404) return null;                // no photo here (sea etc.)
        if (!r.ok) throw new Error(r.status);
        return classify(await pixels(await r.blob()));
      } catch (e) { if (t) { cache.delete(k); return null; } }
    }
  })());
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return cache.get(k);
}

// The tree mask over a lon/lat box -> at(lon, lat) = 1 / 0 / -1 (no photo), plus how many tiles could be read
export async function photoMask(bbox) {
  const tiles = G.tilesFor(bbox, Z), masks = new Map();
  let ok = 0;
  const queue = tiles.slice();
  await Promise.all(Array.from({length: 6}, async () => {
    for (let t; (t = queue.shift());) { const m = await maskTile(t[1], t[2]); if (m) { masks.set(t[1] + "/" + t[2], m); ok++; } }
  }));
  const at = (lon, lat) => {
    const [fx, fy] = G.lonLatToTile(lon, lat, Z), tx = Math.floor(fx), ty = Math.floor(fy);
    const m = masks.get(tx + "/" + ty); if (!m) return -1;
    return m[Math.min(N - 1, Math.floor((fy - ty) * N)) * N + Math.min(N - 1, Math.floor((fx - tx) * N))];
  };
  return {at, tiles: tiles.length, ok};
}

// Share of tree pixels within rM metres of p (a few samples), or -1 when there is no photo
function share(mask, p, rM) {
  let n = 0, hit = 0;
  for (let dy = -rM; dy <= rM; dy += rM / 2) for (let dx = -rM; dx <= rM; dx += rM / 2) {
    if (dx * dx + dy * dy > rM * rM * 1.01) continue;
    const v = mask.at(p[0] + dx / GX, p[1] + dy / GY);
    if (v < 0) return -1;
    n++; hit += v;
  }
  return hit / n;
}

// Trees over a box: [[lon, lat, crown radius m], ...]. keep(p) leaves out buildings, roadways, woods, ...
export function photoTrees(mask, bbox, keep, max = 6000) {
  const sx = PT.step / GX, sy = PT.step / GY, out = [];
  const i0 = Math.floor(bbox[0] / sx), i1 = Math.ceil(bbox[2] / sx), j0 = Math.floor(bbox[1] / sy), j1 = Math.ceil(bbox[3] / sy);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const p = [(i + 0.2 + 0.6 * hash(i, j)) * sx, (j + 0.2 + 0.6 * hash(j, i)) * sy];
    if (p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3]) continue;
    if (mask.at(p[0], p[1]) !== 1) continue;
    if (share(mask, p, PT.near) < PT.need) continue;
    if (!keep(p)) continue;
    const wide = share(mask, p, 4);                    // a big crown when the green goes on around it
    out.push([p[0], p[1], Math.round((1.6 + 1.8 * Math.max(0, wide)) * 10) / 10]);
    if (out.length >= max) return out;
  }
  return out;
}
