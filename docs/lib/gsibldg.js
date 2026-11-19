// Building kinds from the GSI vector tiles (地理院ベクトルタイル, layer BldA, field vt_code), nationwide:
//   3101 普通建物 (ordinary: mostly wooden houses, small buildings)   3102 堅ろう建物 (concrete / steel)
//   3103 高層建物 (high-rise)   3111 普通無壁舎, 3112 堅ろう無壁舎 (roof only: carports, bike sheds)
// Footprints come clipped to each tile; we clip them exactly to the tile square so pieces meet without overlapping.
import { decodeTile, polygons } from "./mvt.js?v=202611200008";
import * as G from "./geo.js?v=202611200008";

export const GSI_BLDG_TILE = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
export const KIND_OF_CODE = {3101: "house", 3102: "building", 3103: "tower", 3111: "shed", 3112: "shed"};
export const KIND_LABEL = {house: "普通建物（民家など）", building: "堅ろう建物（ビル・マンション）", tower: "高層建物", shed: "屋根だけ（車庫など）"};

// Sutherland–Hodgman clip of a ring to the square [0, ext]
function clipSquare(ring, ext) {
  let pts = ring.slice(0, ring.length - 1);
  const edges = [[p => p[0] >= 0, (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; }],
                 [p => p[0] <= ext, (a, b) => { const t = (ext - a[0]) / (b[0] - a[0]); return [ext, a[1] + t * (b[1] - a[1])]; }],
                 [p => p[1] >= 0, (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; }],
                 [p => p[1] <= ext, (a, b) => { const t = (ext - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), ext]; }]];
  for (const [inside, cut] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); }
      else if (inside(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return null;
  }
  return [...pts, pts[0]];
}

const cache = new Map();             // "z/x/y" -> Promise<[{code, rings:[outer lon/lat, ...holes]}]>
export function gsiTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!cache.has(k)) cache.set(k, (async () => {
    try {
      const r = await fetch(GSI_BLDG_TILE(z, x, y));
      if (!r.ok) return [];
      const L = decodeTile(new Uint8Array(await r.arrayBuffer())).BldA;
      if (!L) return [];
      const out = [], toLL = ([px, py]) => G.tileToLonLat(x + px / L.extent, y + py / L.extent, z);
      for (const f of L.features) {
        if (f.type !== 3) continue;
        for (const poly of polygons(f.geom)) {
          const rings = poly.map(r => clipSquare(r, L.extent)).filter(Boolean);
          if (!rings.length) continue;
          out.push({code: f.props.vt_code, rings: rings.map(r => r.map(toLL))});
        }
      }
      return out;
    } catch { cache.delete(k); return []; }
  })());
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return cache.get(k);
}

// All GSI buildings over a lon/lat box (z16 tiles, about 500 m each)
export async function gsiBuildings(bbox) {
  const tiles = G.tilesFor(bbox, 16);
  const lists = await Promise.all(tiles.map(([z, x, y]) => gsiTile(z, x, y)));
  return lists.flat();
}

// A lookup "which GSI building contains this point" over a set of buildings (grid index in lon/lat)
export function makeLookup(list) {
  const cell = 0.0005, grid = new Map();
  list.forEach((b, i) => {
    const bb = G.bboxOf(b.rings[0]);
    for (let x = Math.floor(bb[0] / cell); x <= Math.floor(bb[2] / cell); x++)
      for (let y = Math.floor(bb[1] / cell); y <= Math.floor(bb[3] / cell); y++) {
        const k = x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  return p => {
    const ids = grid.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell)) || [];
    for (const i of ids) if (G.pointInRing(p, list[i].rings[0])) return list[i];
    return null;
  };
}

// Height for a GSI building when the map data has none (or only the 5 m default).
export function guessHeight(kind, areaM2) {
  if (kind === "shed") return 2.8;
  if (kind === "house") return areaM2 > 300 ? 9 : 7.5;
  if (kind === "tower") return 60;
  return areaM2 < 120 ? 10 : areaM2 < 400 ? 15 : areaM2 < 1500 ? 21 : 27;
}
