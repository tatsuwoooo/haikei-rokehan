// A rough name for a place, from the place-name labels of the GSI vector tiles (optimal_bvmap-v1, layer Anno).
// The same tiles the 3D view already reads for the building kinds, so no position is sent anywhere new.
//   210 = town / 町丁目 ("三軒茶屋（一）"), 422 = station, 534 = park, 661 / 662 = shrine / temple, 312 = mountain,
//   110 = city / ward, 140 = prefecture.
import { decodeTile } from "./mvt.js?v=202611200034";
import * as G from "./geo.js?v=202611200034";
import { GSI_BLDG_TILE } from "./gsibldg.js?v=202611200034";

const chome = s => s.replace(/（([一二三四五六七八九十]+)）$/, "$1丁目");

const cache = new Map();
function labels(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!cache.has(k)) cache.set(k, (async () => {
    try {
      const r = await fetch(GSI_BLDG_TILE(z, x, y));
      if (!r.ok) return [];
      const L = decodeTile(new Uint8Array(await r.arrayBuffer())).Anno;
      if (!L) return [];
      const out = [];
      for (const f of L.features) {
        const p = f.props;
        if (f.type !== 1 || !p.vt_text || ![210, 422, 534, 661, 662, 312, 110, 140].includes(p.vt_code)) continue;
        for (const [px, py] of f.geom) out.push({code: p.vt_code, text: p.vt_text, p: G.tileToLonLat(x + px / L.extent, y + py / L.extent, z)});
      }
      return out;
    } catch { cache.delete(k); return []; }
  })());
  if (cache.size > 120) cache.delete(cache.keys().next().value);
  return cache.get(k);
}
// the labels of the 3 x 3 tiles around a point at zoom z
async function around(p, z) {
  const [fx, fy] = G.lonLatToTile(p[0], p[1], z), x = Math.floor(fx), y = Math.floor(fy), jobs = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) jobs.push(labels(z, x + i, y + j));
  return (await Promise.all(jobs)).flat();
}
const nearest = (list, p, code, maxM) => {
  let best = null, bd = maxM;
  for (const l of list) if (l.code === code) { const d = G.dist(p, l.p); if (d < bd) { bd = d; best = l; } }
  return best;
};

// -> "三軒茶屋駅前" / "世田谷公園" / "高尾山" / "三軒茶屋一丁目" / "〇〇駅の近く" / "世田谷区のあたり" / null
export async function placeName(p) {
  const near = await around(p, 15);                                    // tiles about 1 km
  const st = nearest(near, p, 422, 200);
  if (st) return st.text.replace(/駅$/, "") + "駅前";
  const park = nearest(near, p, 534, 350);
  if (park) return park.text;
  const shrine = nearest(near, p, 661, 150) || nearest(near, p, 662, 150);
  if (shrine) return shrine.text;
  const mid = await around(p, 13);                                     // about 4 km
  const mt = nearest(mid, p, 312, 1500) || nearest(near, p, 312, 1500);
  if (mt) return mt.text;
  const town = nearest(near, p, 210, 900);
  if (town) return chome(town.text);
  const st2 = nearest(mid, p, 422, 3000);
  if (st2) return st2.text + "の近く";
  const town2 = nearest(mid, p, 210, 4000);
  if (town2) return chome(town2.text) + "の近く";
  const far = await around(p, 11);                                     // about 20 km
  const city = nearest(far, p, 110, 15000);
  if (city) return city.text + "のあたり";
  const pref = nearest(await around(p, 10), p, 140, 80000);
  return pref ? pref.text + "のあたり" : null;
}
