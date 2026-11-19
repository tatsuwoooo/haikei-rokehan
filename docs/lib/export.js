// Gathers the data for the ranges and packs it into one zip for Blender (see notes/format.md).
//   detail ranges: OpenStreetMap through Overpass (buildings with tags, roads, trees, signals, lamps, ...), per 1/2 mesh
//   mid ranges:    OpenFreeMap vector tiles (building footprints + heights, roads), per 3rd mesh
//   far ranges:    OpenFreeMap vector tiles, every building as a box (centre, width, depth, angle, height)
//   terrain:       GSI elevation tiles as they are (dem5a z15 for detail, dem z14 / z13)
import * as G from "./geo.js?v=202611200145";
import { decodeTile, polygons } from "./mvt.js?v=202611200145";
import { makeZip } from "./zip.js?v=202611200145";
import { GSI_DEM, GSI_DEM5A } from "./gsidem.js?v=202611200145";
import { gsiTile, gsiBuildings, makeLookup, guessHeight, KIND_OF_CODE } from "./gsibldg.js?v=202611200145";
import { ringOf, bboxOfShape, LEVELS, autoCenter } from "./shapes.js?v=202611200145";
import { autoProps, classOfOsm, treesFor } from "./props.js?v=202611200145";
import { photoMask } from "./phototrees.js?v=202611200145";
import { omtArea } from "./omttile.js?v=202611200145";

// Order of tries: the main server gets most of them; the backups are often unreachable, so they get a short limit.
const OVERPASS_MAIN = "https://overpass-api.de/api/interpreter";
const OVERPASS_TRIES = [[OVERPASS_MAIN, 120], ["https://overpass.private.coffee/api/interpreter", 40], [OVERPASS_MAIN, 120],
  ["https://overpass.kumi.systems/api/interpreter", 40], [OVERPASS_MAIN, 150], [OVERPASS_MAIN, 150]];
export const OMT_TILEJSON = "https://tiles.openfreemap.org/planet";
const RANK = {detail: 3, mid: 2, far: 1};
const r2 = v => Math.round(v * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, opt = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opt);
      if (res.ok || res.status === 404) return res;
      last = new Error(`HTTP ${res.status}`);
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (i + 1)); continue; }
      return res;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

export async function overpass(q, log) {
  let err;
  for (let i = 0; i < OVERPASS_TRIES.length; i++) {
    const [url, secs] = OVERPASS_TRIES[i], host = new URL(url).host;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), secs * 1000);   // a server that hangs: try the next one
    try {
      const res = await fetch(url, {method: "POST", body: "data=" + encodeURIComponent(q), headers: {"Content-Type": "application/x-www-form-urlencoded"}, signal: ctl.signal});
      if (res.ok) return await res.json();
      err = new Error(`Overpass HTTP ${res.status}`);
      log(`  OSM（${host}）が混んでいます（${res.status}）。別のサーバーで試します…`);
      await sleep(2000 * (i + 1));
    } catch (e) {
      err = e; log(`  OSM（${host}）から返事がありません。別のサーバーで試します…`);
      await sleep(1000);
    } finally { clearTimeout(timer); }
  }
  throw new Error("OSM のデータが取れませんでした（" + (err && err.message) + "）。少しして、もう一度書き出してください。");
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function prefectureAt(lon, lat) {
  try {
    const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
    const j = await r.json();
    return j && j.results && j.results.muniCd ? parseInt(String(j.results.muniCd).padStart(5, "0").slice(0, 2), 10) : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ OSM (detail)
const OSM_QUERY = bb => `[out:json][timeout:90];
(
way["building"](${bb});relation["building"]["type"="multipolygon"](${bb});
way["highway"](${bb});way["railway"](${bb});way["waterway"](${bb});
way["natural"~"^(water|wood|scrub|grassland)$"](${bb});relation["natural"="water"](${bb});
way["leisure"~"^(park|garden|pitch|playground)$"](${bb});
way["landuse"~"^(grass|forest|cemetery|railway|parking|construction|meadow)$"](${bb});
way["amenity"="parking"](${bb});way["barrier"](${bb});way["power"~"^(line|minor_line)$"](${bb});
way["man_made"~"^(bridge|pier)$"](${bb});way["natural"="tree_row"](${bb});
node["natural"="tree"](${bb});
node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop|stop|give_way)$"](${bb});
node["amenity"~"^(vending_machine|bench|post_box|telephone|bicycle_parking|waste_basket|toilets)$"](${bb});
node["power"~"^(pole|tower)$"](${bb});node["man_made"~"^(utility_pole|street_cabinet)$"](${bb});
node["emergency"="fire_hydrant"](${bb});node["traffic_sign"](${bb});
);
out tags geom qt;`;

const num = v => { if (v == null) return null; const m = String(v).replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
function buildingHeight(t, areaM2) {
  const h = num(t.height), lv = num(t["building:levels"]), rl = num(t["roof:levels"]) || 0;
  if (h) return [h, "height"];
  if (lv) return [lv * 3.2 + rl * 2.0 + (lv <= 2 ? 1.0 : 0.5), "levels"];
  const b = t.building || "yes";
  if (/^(house|detached|semidetached_house|bungalow|hut|shed|garage|garages|kiosk)$/.test(b)) return [b === "house" || b === "detached" ? 7.5 : 3.5, "guess"];
  if (/^(apartments|dormitory)$/.test(b)) return [areaM2 > 600 ? 24 : 12, "guess"];
  if (/^(commercial|retail|office|hotel)$/.test(b)) return [areaM2 > 800 ? 30 : 15, "guess"];
  if (/^(industrial|warehouse|factory)$/.test(b)) return [9, "guess"];
  return [areaM2 < 100 ? 6.5 : areaM2 < 300 ? 9 : areaM2 < 1000 ? 15 : 22, "guess"];
}
// Join the outer ways of a multipolygon relation into closed rings.
function joinRings(ways) {
  const segs = ways.filter(w => w.length > 1).map(w => w.slice()), rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (segs.length) {
    let cur = segs.shift();
    let grew = true;
    while (!same(cur[0], cur[cur.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = cur[cur.length - 1];
        if (same(end, s[0])) cur = cur.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) cur = cur.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}
const ll = g => g.map(p => [p.lon, p.lat]);
const PICK_TAGS = ["name", "lanes", "width", "oneway", "layer", "bridge", "tunnel", "sidewalk", "surface", "crossing", "direction",
  "height", "species", "leaf_type", "vending", "ref", "service", "cycleway", "barrier", "material", "colour", "covered", "level"];
const pickTags = t => { const o = {}; for (const k of PICK_TAGS) if (t[k] != null) o[k] = t[k]; return o; };
function pointKind(t) {
  if (t.natural === "tree") return "tree";
  if (t.highway === "street_lamp") return "street_lamp";
  if (t.highway === "traffic_signals") return "traffic_signals";
  if (t.highway === "crossing") return "crossing";
  if (t.highway === "bus_stop") return "bus_stop";
  if (t.highway === "stop" || t.highway === "give_way" || t.traffic_sign) return "sign";
  if (t.power === "pole" || t.man_made === "utility_pole") return "utility_pole";
  if (t.power === "tower") return "power_tower";
  if (t.man_made === "street_cabinet") return "street_cabinet";
  if (t.emergency === "fire_hydrant") return "fire_hydrant";
  if (t.amenity) return t.amenity;
  return null;
}
function areaKind(t) {
  if (t.natural === "water" || t.waterway === "riverbank") return "water";
  if (t.natural === "wood" || t.landuse === "forest") return "forest";
  if (t.natural === "scrub") return "scrub";
  if (t.leisure === "park" || t.leisure === "garden") return "park";
  if (t.leisure === "pitch" || t.leisure === "playground") return t.leisure;
  if (t.landuse === "grass" || t.landuse === "meadow" || t.natural === "grassland") return "grass";
  if (t.landuse === "parking" || t.amenity === "parking") return "parking";
  if (t.landuse) return t.landuse;
  if (t.man_made) return t.man_made;
  return null;
}

// ------------------------------------------------------------------ main
// folder: every file goes inside this folder of the zip (so unpacking gives one folder); extraFiles are added to it.
// viewpoint: the 中心点 {lonlat, h (m above the ground), set (placed by the user)}; without one, the middle of the most detailed ranges.
export async function exportData({shapes, settings, place, omtTiles, viewpoint = null, folder = "", extraFiles = [], onProgress = () => {}, log = () => {}}) {
  const t0 = Date.now();
  const ranges = shapes.filter(s => s.level !== "none").map(s => ({id: s.id, name: s.name, level: s.level, kind: s.kind, ring: ringOf(s), bbox: bboxOfShape(s), shape: s}));
  if (!ranges.length) throw new Error("作る範囲がありません。");
  const all = G.bboxOf(ranges.flatMap(r => r.ring));
  // The 中心点: the far boards are shot from here, the circle of 範囲の外 goes round it, and the local origin is put here.
  // (Before 2026-11-20 this was the middle of every range, so a big far range pulled it away from the place itself.)
  const center = (viewpoint && viewpoint.lonlat) || autoCenter(shapes) || [(all[0] + all[2]) / 2, (all[1] + all[3]) / 2];
  if (settings.outside === "far") {
    const R = settings.outsideR || 2000, n = 72, ring = [];
    for (let i = 0; i <= n; i++) ring.push(G.offset(center, R * Math.cos(i / n * 2 * Math.PI), R * Math.sin(i / n * 2 * Math.PI)));
    ranges.push({id: "outside", name: "範囲の外", level: "far", kind: "circle", ring, bbox: G.bboxOf(ring), outside: true});
  }

  onProgress("座標の準備", 0.02);
  const pref = await prefectureAt(center[0], center[1]);
  const zone = G.zoneFor(pref, center[1], center[0]);
  const plane = G.makePlane(zone);
  const pc = plane(center[0], center[1]);
  const origin = [Math.round(pc[0] / 10) * 10, Math.round(pc[1] / 10) * 10];
  const L = (lon, lat) => { const p = plane(lon, lat); return [r2(p[0] - origin[0]), r2(p[1] - origin[1])]; };
  const LR = ring => ring.map(p => L(p[0], p[1]));
  log(`平面直角座標系 第${zone}系（都道府県コード ${pref ?? "不明"}）。原点 = 東 ${origin[0]} m・北 ${origin[1]} m`);

  const rankAt = p => { let best = 0, rg = null; for (const r of ranges) { const k = RANK[r.level]; if (k > best && G.pointInRing(p, r.ring)) { best = k; rg = r; } } return [best, rg]; };

  // sections
  const sections = new Map();
  const cellTouches = G.ringTouchesBox;
  const addSection = (id, level, mesh, bounds, range) => {
    if (!sections.has(id)) sections.set(id, {id, level, mesh, bounds, ranges: [], buildings: [], roads: [], rails: [], areas: [], barriers: [], power: [], points: []});
    if (range && !sections.get(id).ranges.includes(range.id)) sections.get(id).ranges.push(range.id);
  };
  for (const r of ranges) {
    if (r.level === "detail" || r.level === "mid") {
      const lvl = r.level === "detail" ? 4 : 3;
      for (const code of G.meshCells(r.bbox, lvl)) { const b = G.meshBounds(code); if (cellTouches(b, r.ring)) addSection(`${r.level}_${code}`, r.level, code, b, r); }
    } else addSection(`far_${r.id}`, "far", null, r.bbox, r);
  }
  const secFor = (p, rank, rg) => rank === 3 ? sections.get("detail_" + G.meshCode(p[1], p[0], 4))
    : rank === 2 ? sections.get("mid_" + G.meshCode(p[1], p[0], 3)) : rank === 1 ? sections.get("far_" + rg.id) : null;
  log(`区画: 詳細 ${[...sections.values()].filter(s => s.level === "detail").length}・中景 ${[...sections.values()].filter(s => s.level === "mid").length}・板ポリ ${[...sections.values()].filter(s => s.level === "far").length}`);

  // ---- detail: OSM
  const details = [...sections.values()].filter(s => s.level === "detail");
  const seenLines = new Set();
  // Ask only for the part of each cell its ranges cover (+40 m), and put small areas together in one request:
  // the public Overpass servers are slow (tens of seconds per request) and count every request.
  const pad = (b, mm) => { const m = G.mPerDeg(b[1]); return [b[0] - mm / m.lon, b[1] - mm / m.lat, b[2] + mm / m.lon, b[3] + mm / m.lat]; };
  const clip = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const areaKm2 = b => { const d = G.delta([b[0], b[1]], [b[2], b[3]]); return Math.abs(d[0] * d[1]) / 1e6; };
  for (const sec of details) {
    const rb = G.bboxOf(ranges.filter(r => sec.ranges.includes(r.id)).flatMap(r => r.ring));
    sec.qb = pad(clip(sec.bounds, rb), 40);
  }
  const groups = [];
  for (const sec of details) {
    const g = groups.find(g => areaKm2(G.bboxOf([[g.b[0], g.b[1]], [g.b[2], g.b[3]], [sec.qb[0], sec.qb[1]], [sec.qb[2], sec.qb[3]]])) <= 1.0);
    if (g) { g.secs.push(sec); g.b = G.bboxOf([[g.b[0], g.b[1]], [g.b[2], g.b[3]], [sec.qb[0], sec.qb[1]], [sec.qb[2], sec.qb[3]]]); }
    else groups.push({b: sec.qb.slice(), secs: [sec]});
  }
  log(`OSM への問い合わせ: ${groups.length} 回`);
  const jobs = [];
  for (let k = 0; k < groups.length; k++) {
    const gr = groups[k];
    onProgress(`OSM を取得中（${k + 1}/${groups.length}）`, 0.05 + 0.45 * k / Math.max(1, groups.length));
    const js = await overpass(OSM_QUERY(`${gr.b[1]},${gr.b[0]},${gr.b[3]},${gr.b[2]}`), log);
    for (const sec of gr.secs) jobs.push([sec, js]);
    if (k < groups.length - 1) await sleep(1000);           // be gentle with the public Overpass servers
  }
  for (const [sec, js] of jobs) {
    let nb = 0;
    const touches = pts => { const b = G.bboxOf(pts); return G.boxesOverlap(b, sec.qb); };
    for (const el of js.elements || []) {
      const t = el.tags || {};
      if (el.type === "node") {
        const kind = pointKind(t), p = [el.lon, el.lat];
        if (!kind) continue;
        const [rank] = rankAt(p);
        if (rank !== 3 || G.meshCode(p[1], p[0], 4) !== sec.mesh) continue;
        sec.points.push({kind, p: L(...p), tags: pickTags(t), id: "n" + el.id});
        continue;
      }
      let rings = null, line = null;
      if (el.type === "way" && el.geometry) {
        const g = ll(el.geometry);
        const closed = g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
        if (closed && (t.building || areaKind(t) || (t.area === "yes"))) rings = [g]; else line = g;
      } else if (el.type === "relation" && el.members) {
        const outer = el.members.filter(m => m.role === "outer" && m.geometry).map(m => ll(m.geometry));
        const inner = el.members.filter(m => m.role === "inner" && m.geometry).map(m => ll(m.geometry));
        rings = joinRings(outer); if (rings.length) rings.inner = joinRings(inner);
      }
      if (t.building && rings && rings.length) {
        for (const ring of rings) {
          const lr = LR(ring), c = G.ringCentroid(lr), cll = G.ringCentroid(ring);
          const [rank] = rankAt(cll);
          if (rank !== 3 || G.meshCode(cll[1], cll[0], 4) !== sec.mesh) continue;
          const area = G.ringArea(lr), [h, src] = buildingHeight(t, area);
          const holes = (rings.inner || []).filter(hr => G.pointInRing(hr[0], ring)).map(LR);
          sec.buildings.push({id: el.type[0] + el.id, fp: lr.slice(0, -1), holes: holes.map(hh => hh.slice(0, -1)), h: r2(h), hSrc: src,
            minH: num(t.min_height) || (num(t["building:min_level"]) || 0) * 3.2, levels: num(t["building:levels"]), use: t.building,
            roof: t["roof:shape"] || null, colour: t["building:colour"] || null, material: t["building:material"] || null, name: t.name || null,
            c: c.map(r2), area: Math.round(area), _ll: cll});
          nb++;
        }
        continue;
      }
      const key = el.type + el.id + "@" + sec.id;
      if (seenLines.has(key)) continue; seenLines.add(key);
      if (!touches(line || (rings && rings[0]) || [])) continue;
      if (rings && rings.length) {
        const kind = areaKind(t); if (!kind) continue;
        sec.areas.push({id: el.type[0] + el.id, kind, rings: rings.map(LR), tags: pickTags(t)});
      } else if (line) {
        const rec = {id: "w" + el.id, pts: LR(line), tags: pickTags(t)};
        if (t.highway) {
          sec.roads.push(Object.assign(rec, {kind: t.highway}));
          const cls = classOfOsm(t.highway);
          if (cls) (sec._roadsLL || (sec._roadsLL = [])).push({cls, pts: line,
            brunnel: t.bridge && t.bridge !== "no" ? "bridge" : t.tunnel && t.tunnel !== "no" ? "tunnel" : null});
        }
        else if (t.railway) sec.rails.push(Object.assign(rec, {kind: t.railway}));
        else if (t.waterway) sec.areas.push({id: rec.id, kind: "waterway_" + t.waterway, line: rec.pts, tags: rec.tags});
        else if (t.barrier) sec.barriers.push(Object.assign(rec, {kind: t.barrier}));
        else if (t.power) sec.power.push(Object.assign(rec, {kind: t.power}));
        else if (t.man_made) sec.areas.push({id: rec.id, kind: t.man_made, line: rec.pts, tags: rec.tags});
        else if (t.natural === "tree_row") (sec._rowsLL || (sec._rowsLL = [])).push(line);
      }
    }
    // the map tiles the 3D view uses (roads, green areas), so what is placed below stands where the browser showed it
    let area = null;
    try {
      const tpl = omtTiles || (await (await fetch(OMT_TILEJSON)).json()).tiles[0];
      area = await omtArea(tpl, pad(sec.bounds, 250));
    } catch {}
    const mine = p => rankAt(p)[0] === 3 && G.meshCode(p[1], p[0], 4) === sec.mesh;
    // street furniture placed from the road shapes (the same rules as the 3D view); only what stands in this cell
    if (sec._roadsLL) {
      const osm = {signals: [], lamps: [], poles: []};
      for (const el of js.elements || []) {
        if (el.type !== "node") continue;
        const t = el.tags || {}, p = [el.lon, el.lat];
        if (t.highway === "traffic_signals") osm.signals.push(p);
        else if (t.highway === "street_lamp") osm.lamps.push(p);
        else if (t.power === "pole" || t.man_made === "utility_pole") osm.poles.push(p);
      }
      // roads from the same map tiles as the 3D view, so the poles stand where the browser showed them
      // (the OpenStreetMap roads of this section are used only if the tiles cannot be read)
      const roadsForProps = area && area.roads.length ? area.roads : sec._roadsLL;
      const ap = autoProps(roadsForProps, osm);
      let na = 0;
      const add = (list, kind, extra) => { for (const o of list) if (!o.osm && mine(o.p)) { sec.points.push({kind, auto: true, p: L(...o.p), a: r2(o.a), ...extra(o)}); na++; } };
      add(ap.poles, "utility_pole", () => ({}));
      add(ap.lamps, "street_lamp", () => ({}));
      add(ap.signals, "traffic_signals", o => ({arm: r2(o.arm)}));
      add(ap.crossings, "crossing", o => ({w: r2(o.w), d: o.d}));
      for (const [a, b] of ap.wires) if (mine(a)) sec.power.push({kind: "minor_line", auto: true, pts: [L(...a), L(...b)]});
      delete sec._roadsLL;
      log(`  ${sec.id}: 電柱・街灯・信号・横断歩道を自動で ${na} 個`);
    }
    // trees besides the OpenStreetMap ones (the same as the 3D view): tree rows, woods and parks, and the aerial photo
    {
      const osmTrees = (js.elements || []).filter(el => el.type === "node" && el.tags && el.tags.natural === "tree").map(el => [el.lon, el.lat]);
      const bbox = sec.bounds.slice();
      let mask = null, inBuilding = null;
      try { mask = await photoMask(bbox); } catch {}
      try { inBuilding = makeLookup(await gsiBuildings(pad(bbox, 30))); } catch {}
      const trees = treesFor({osmTrees, rows: sec._rowsLL || [], green: area ? area.green : [], roads: area ? area.roads : [],
        inBuilding, mask, bbox, keep: mine, max: 80000});
      const cnt = {};
      for (const t of trees) {
        if (t.src === "osm") continue;
        const o = {kind: "tree", auto: true, src: t.src, p: L(...t.p)};
        if (t.r) o.r = t.r;
        sec.points.push(o); cnt[t.src] = (cnt[t.src] || 0) + 1;
      }
      delete sec._rowsLL;
      const nm = {row: "並木", wood: "林", park: "公園", photo: "写真から"};
      const parts = Object.keys(cnt).map(k => `${nm[k] || k} ${cnt[k]}`);
      log(`  ${sec.id}: 木を自動で ${parts.length ? parts.join("・") : "0"}` + (mask && mask.ok < mask.tiles ? `（写真 ${mask.tiles - mask.ok} 枚が読めず）` : mask ? "" : "（写真を読めず）"));
    }
    log(`  ${sec.id}: 建物 ${nb}・道 ${sec.roads.length}・木や小物 ${sec.points.length}`);
  }

  // ---- mid + far: vector tiles (z14)
  const tiled = ranges.filter(r => r.level === "mid" || r.level === "far");
  if (tiled.length) {
    const bb = G.bboxOf(tiled.flatMap(r => r.ring));
    const tiles = G.tilesFor(bb, 14);
    let done = 0, nmid = 0, nfar = 0;
    onProgress(`建物の地図タイルを取得中（0/${tiles.length}）`, 0.5);
    const tpl = omtTiles || (await (await fetch(OMT_TILEJSON)).json()).tiles[0];
    const midRoads = new Map();
    await pool(tiles, 4, async ([z, x, y]) => {
      const res = await fetchRetry(tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y));
      done++; onProgress(`建物の地図タイルを取得中（${done}/${tiles.length}）`, 0.5 + 0.3 * done / tiles.length);
      if (!res.ok) return;
      const layers = decodeTile(new Uint8Array(await res.arrayBuffer()));
      const toLL = (ext) => ([px, py]) => G.tileToLonLat(x + px / ext, y + py / ext, z);
      const bl = layers.building;
      if (bl) for (const f of bl.features) {
        if (f.type !== 3 || f.props.hide_3d) continue;
        for (const poly of polygons(f.geom)) {
          const outer = poly[0];
          const cT = G.ringCentroid(outer);
          if (cT[0] < 0 || cT[0] >= bl.extent || cT[1] < 0 || cT[1] >= bl.extent) continue;   // owned by the next tile
          const ringLL = outer.map(toLL(bl.extent)), cll = G.ringCentroid(ringLL);
          const [rank, rg] = rankAt(cll);
          if (rank !== 2 && rank !== 1) continue;
          const sec = secFor(cll, rank, rg); if (!sec) continue;
          const lr = LR(ringLL), h = r2(f.props.render_height || 6), minH = f.props.render_min_height || 0;
          if (rank === 2) { sec.buildings.push({fp: lr.slice(0, -1), h, hSrc: f.props.render_height && f.props.render_height !== 5 ? "map" : "default", minH, _ll: cll, _area: G.ringArea(lr)}); nmid++; }
          else { const ob = G.orientedBox(lr.slice(0, -1)); sec.buildings.push({box: ob.map(r2), h}); nfar++; }
        }
      }
      const tl = layers.transportation;
      if (tl) for (const f of tl.features) {
        if (f.type !== 2) continue;
        for (const line of f.geom) {
          const lineLL = line.map(toLL(tl.extent));
          for (const sec of sections.values()) {
            if (sec.level !== "mid") continue;
            if (!lineLL.some(p => p[0] >= sec.bounds[0] && p[0] <= sec.bounds[2] && p[1] >= sec.bounds[1] && p[1] <= sec.bounds[3])) continue;
            const key = sec.id;
            if (!midRoads.has(key)) midRoads.set(key, []);
            midRoads.get(key).push({kind: f.props.class, sub: f.props.subclass || null, brunnel: f.props.brunnel || null, layer: f.props.layer || 0, pts: LR(lineLL)});
          }
        }
      }
    });
    for (const [k, v] of midRoads) sections.get(k).roads = v;
    log(`中景の建物 ${nmid}・板ポリの建物 ${nfar}`);
  }

  // ---- terrain
  const wantTerrain = settings.terrain !== false;
  const tileSet = new Map();
  if (wantTerrain) for (const sec of sections.values()) {
    const m = G.mPerDeg(sec.bounds[1]), pad = 60;
    const b = [sec.bounds[0] - pad / m.lon, sec.bounds[1] - pad / m.lat, sec.bounds[2] + pad / m.lon, sec.bounds[3] + pad / m.lat];
    const want = sec.level === "detail" ? [["dem5a", 15], ["dem", 14]] : sec.level === "mid" ? [["dem", 14]] : [["dem", 13]];
    sec.terrain = [];
    for (const [src, z] of want) for (const [zz, x, y] of G.tilesFor(b, z)) {
      const name = `terrain/${src}/${zz}/${x}/${y}.png`;
      sec.terrain.push(name);
      tileSet.set(name, {src, z: zz, x, y});
    }
  }
  const files = [];
  const tlist = [...tileSet.entries()];
  let td = 0;
  await pool(tlist, 6, async ([name, t]) => {
    const url = t.src === "dem5a" ? GSI_DEM5A(t.z, t.x, t.y) : GSI_DEM(t.z, t.x, t.y);
    const res = await fetchRetry(url);
    td++; onProgress(`地形を取得中（${td}/${tlist.length}）`, 0.8 + 0.12 * td / tlist.length);
    if (res.ok) files.push({name, data: new Uint8Array(await res.arrayBuffer())}); else t.missing = true;
  });

  // ---- building kinds from GSI (普通建物 / 堅ろう建物 / 高層建物 / 無壁舎), for detail and mid sections
  const kindSecs = [...sections.values()].filter(s => (s.level === "detail" || s.level === "mid") && s.buildings.length);
  if (kindSecs.length) {
    const tiles = G.tilesFor(G.bboxOf(kindSecs.flatMap(s => [[s.bounds[0], s.bounds[1]], [s.bounds[2], s.bounds[3]]])), 16);
    if (tiles.length > 400) log(`建物の種類: 範囲が広すぎるので省きました（地図タイル ${tiles.length} 枚）`);
    else {
      let td = 0;
      const lists = [];
      await pool(tiles, 6, async ([z, x, y]) => {
        lists.push(await gsiTile(z, x, y));
        td++; onProgress(`建物の種類を取得中（${td}/${tiles.length}）`, 0.92 + 0.01 * td / tiles.length);
      });
      const at = makeLookup(lists.flat());
      let hit = 0, all = 0;
      for (const sec of kindSecs) for (const b of sec.buildings) {
        all++;
        const g = at(b._ll); if (!g) continue;
        hit++; b.gsi = g.code; b.kind = KIND_OF_CODE[g.code] || null;
        // a better height guess when the data had none
        if (b.kind && (b.hSrc === "guess" && (!b.use || b.use === "yes") || b.hSrc === "default"))
          { b.h = r2(guessHeight(b.kind, b.area || b._area || 100)); b.hSrc = "kind"; }
      }
      log(`建物の種類: ${all} 棟のうち ${hit} 棟が分かりました（国土地理院）`);
    }
  }
  for (const s of sections.values()) for (const b of s.buildings) { delete b._ll; delete b._area; }

  // ---- pack
  onProgress("ファイルにまとめています", 0.93);
  const secList = [...sections.values()].map(s => {
    const {buildings, roads, rails, areas, barriers, power, points, terrain, ...head} = s;
    return Object.assign(head, {
      file: `sections/${s.id}.json`,
      bounds_local: [L(s.bounds[0], s.bounds[1]), L(s.bounds[2], s.bounds[3])].flat(),
      counts: {buildings: buildings.length, roads: roads.length, points: points.length},
      terrain: (terrain || []).filter(n => !tileSet.get(n).missing),
    });
  });
  for (const s of sections.values())
    files.push({name: `sections/${s.id}.json`, data: JSON.stringify({id: s.id, level: s.level, mesh: s.mesh,
      buildings: s.buildings, roads: s.roads, rails: s.rails, areas: s.areas, barriers: s.barriers, power: s.power, points: s.points})});
  const manifest = {
    format: "haikei-rokehan", version: 1, created: new Date().toISOString(),
    place: place || null, center, zone, prefecture: pref,
    viewpoint: {lonlat: center, local: L(center[0], center[1]), h: (viewpoint && viewpoint.h) || 1.6, auto: !(viewpoint && viewpoint.set)},
    origin: {plane: origin, note: "local = plane rectangular [east, north] (m) - origin.plane"},
    settings, ranges: ranges.map(r => ({id: r.id, name: r.name, level: r.level, kind: r.kind, outside: !!r.outside, ring_lonlat: r.ring, ring_local: LR(r.ring), shape: r.shape || null})),
    sections: secList,
    terrain: {encoding: "gsi-png: h = (R*65536+G*256+B)*0.01 m, (128,0,0) = no data", tiles: tlist.filter(([, t]) => !t.missing).map(([name, t]) => ({file: name, ...t}))},
    attribution: ["© OpenStreetMap contributors (ODbL)", "OpenFreeMap © OpenMapTiles", "国土地理院 標高タイル", "国土地理院 ベクトルタイル（建物の種類）", "国土地理院 シームレス空中写真（木の位置の推定）"],
  };
  files.unshift({name: "manifest.json", data: JSON.stringify(manifest, null, 1)});
  files.push(...extraFiles);
  const pre = folder ? folder.replace(/\/+$/, "") + "/" : "";
  const blob = await makeZip(files.map(f => ({name: pre + f.name, data: f.data})), (i, n) => onProgress("ファイルにまとめています", 0.93 + 0.07 * i / n));
  onProgress("できました", 1);
  log(`できました（${(blob.size / 1048576).toFixed(1)} MB・${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  return {blob, manifest, files};
}
