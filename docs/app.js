// 背景ロケハン: pick a place in 3D, place ranges (rect / circle / mesh grid), export the data for Blender.
// One page for phone and PC: the PC layout adds a top-down map next to the 3D view.
import * as G from "./lib/geo.js";
import { registerGsiDem } from "./lib/gsidem.js";
import { LEVELS, ringOf, handlesOf, dragHandle, drawShape, sizeText, centerOf, areaOf, fmtM, boxSize, bboxOfShape } from "./lib/shapes.js";
import { exportData, OMT_TILEJSON } from "./lib/export.js";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const PC = matchMedia("(min-width: 900px)").matches;
document.body.classList.add(PC ? "pc" : "phone");
matchMedia("(min-width: 900px)").addEventListener("change", () => location.reload());
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

// ------------------------------------------------------------------ state (kept in this browser)
const DEF = {
  view: {center: [139.7005, 35.6595], zoom: 16.4, bearing: -20, pitch: 58}, mode: "oblique",
  place: {name: "渋谷スクランブル交差点", c: [139.7005, 35.6595]},
  base: "map", terrain: true, trees: true, fog: 1, eyeH: 60, gridLevel: 4, showGrid: true,
  outside: "none", outsideR: 2000, shapes: [], nextId: 1,
};
let S;
try { S = Object.assign(clone(DEF), JSON.parse(localStorage.getItem("rokehan") || "{}")); } catch { S = clone(DEF); }
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem("rokehan", JSON.stringify(S)); } catch {} }, 300); };
let sel = null, tool = "select";

let toastT = 0;
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms); }

// ------------------------------------------------------------------ maps
registerGsiDem(maplibregl);
function style(role) {
  const ramp = ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 6], 0, "#dcdde2", 40, "#c9ccd4", 120, "#b3b9c6", 250, "#9fa8ba"];
  return {
    version: 8,
    sources: {
      pale: {type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'},
      photo: {type: "raster", tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"], tileSize: 256, maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院（写真）</a>'},
      ...(OMT ? {omt: OMT} : {}),
      dem: {type: "raster-dem", tiles: ["gsidem://{z}/{x}/{y}"], tileSize: 256, maxzoom: 14, encoding: "terrarium",
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院 標高タイル</a>'},
    },
    layers: [
      {id: "bg", type: "background", paint: {"background-color": "#e6e7ea"}},
      {id: "pale", type: "raster", source: "pale", layout: {visibility: S.base === "map" ? "visible" : "none"}},
      {id: "photo", type: "raster", source: "photo", layout: {visibility: S.base === "photo" ? "visible" : "none"}},
    ].concat(!OMT ? [] : [role === "3d"
        ? {id: "bld", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13, filter: ["!=", ["get", "hide_3d"], true],
           paint: {"fill-extrusion-color": ramp, "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
                   "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.96, "fill-extrusion-vertical-gradient": true}}
        : {id: "bld", type: "fill", source: "omt", "source-layer": "building", minzoom: 13, paint: {"fill-color": ramp, "fill-outline-color": "#9ea3ae", "fill-opacity": S.base === "photo" ? 0.35 : 0.9}}]),
  };
}

// The buildings come from OpenFreeMap. Read its tile address first, so a busy server only costs the buildings, not the map.
async function loadOmt() {
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(OMT_TILEJSON, {signal: ctl.signal}); clearTimeout(t);
      if (r.ok) { const j = await r.json(); return {type: "vector", tiles: j.tiles, minzoom: j.minzoom || 0, maxzoom: j.maxzoom || 14, attribution: j.attribution || "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"}; }
    } catch {}
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return null;
}
const OMT = await loadOmt();
if (!OMT) setTimeout(() => toast("建物の地図データ（OpenFreeMap）が読み込めませんでした。少しして開き直してください。", 6000), 500);

// The 3D view is driven by our own free camera (see "camera" below): no zoom or pitch limit worth noticing,
// the centre may float above the ground, and the camera may go down to the ground or below it.
const map3 = new maplibregl.Map({container: "map3d", style: style("3d"), center: S.view.center, zoom: Math.min(S.view.zoom, 23),
  bearing: S.view.bearing, pitch: Math.min(S.view.pitch, 85), maxPitch: 150, maxZoom: 24, centerClampedToGround: false,
  attributionControl: {compact: true}});
if (!PC) { map3.dragPan.disable(); map3.touchZoomRotate.disable(); map3.touchPitch.disable(); map3.doubleClickZoom.disable(); }
map3.scrollZoom.disable();                        // the wheel moves the camera itself (no end to zooming in)
const mapT = PC ? new maplibregl.Map({container: "maptop", style: style("top"), center: S.view.center, zoom: Math.max(13, Math.min(16.5, S.view.zoom - 1.2)),
  maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false}) : null;
const maps = PC ? [map3, mapT] : [map3];
window.__maps = maps;

const fogBlend = () => Math.min(0.97, Math.max(0.3, 0.32 + 0.16 * Math.log2(1 + S.fog * 2.2)));
function applySky() {
  try {
    map3.setSky({"sky-color": "#8fb3d9", "horizon-color": "#e3e8ef", "fog-color": "#e3e8ef", "fog-ground-blend": fogBlend(),
      "horizon-fog-blend": 0.7, "sky-horizon-blend": 0.6, "atmosphere-blend": 0});
  } catch {}
}
function applyTerrain() { try { map3.setTerrain(S.terrain ? {source: "dem", exaggeration: 1} : null); } catch {} }

const EMPTY = {type: "FeatureCollection", features: []};
function addAppLayers(m, role) {
  for (const id of ["grid", "shapes", "handles", "draft", "trees", "cam"]) m.addSource(id, {type: "geojson", data: EMPTY});
  if (role === "3d") m.addLayer({id: "trees", type: "fill-extrusion", source: "trees", minzoom: 14,
    paint: {"fill-extrusion-color": "#5f8f57", "fill-extrusion-height": 9, "fill-extrusion-base": 2.2, "fill-extrusion-opacity": 0.95}}, m.getLayer("bld") ? "bld" : undefined);
  m.addLayer({id: "grid", type: "line", source: "grid", paint: {"line-color": "rgba(40,40,70,.55)", "line-width": 1, "line-dasharray": [3, 3]}});
  m.addLayer({id: "shapes-fill", type: "fill", source: "shapes", paint: {"fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "sel"], 0.3, 0.16]}});
  m.addLayer({id: "shapes-line", type: "line", source: "shapes", filter: ["!=", ["get", "level"], "far"],
    paint: {"line-color": ["get", "color"], "line-width": ["case", ["get", "sel"], 3.2, 2.2]}});
  m.addLayer({id: "shapes-dash", type: "line", source: "shapes", filter: ["==", ["get", "level"], "far"],
    paint: {"line-color": ["get", "color"], "line-width": ["case", ["get", "sel"], 3, 2], "line-dasharray": [3, 2]}});
  m.addLayer({id: "draft", type: "line", source: "draft", paint: {"line-color": "#f39a2b", "line-width": 2.5, "line-dasharray": [2, 1]}});
  if (role === "top") {
    m.addLayer({id: "cam-cone", type: "fill", source: "cam", filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#ff5a4a", "fill-opacity": 0.16}});
    m.addLayer({id: "cam-pt", type: "circle", source: "cam", filter: ["==", ["geometry-type"], "Point"], paint: {"circle-radius": 6, "circle-color": "#ff5a4a", "circle-stroke-color": "#fff", "circle-stroke-width": 2}});
  }
  m.addLayer({id: "handles", type: "circle", source: "handles", paint: {
    "circle-radius": PC ? 7 : 10, "circle-color": ["case", ["==", ["get", "type"], "rotate"], ["get", "color"], "#ffffff"],
    "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5}});
}

let loaded = 0;
const safe = (name, f) => { try { f(); } catch (e) { console.error(name, e); } };
map3.on("load", () => {
  safe("layers", () => addAppLayers(map3, "3d")); safe("sky", applySky); safe("terrain", applyTerrain);
  if (++loaded === maps.length) safe("ready", ready);
});
if (mapT) mapT.on("load", () => { safe("layers", () => addAppLayers(mapT, "top")); if (++loaded === maps.length) safe("ready", ready); });
map3.on("error", e => console.warn("map error", e && e.error && e.error.message));

function ready() {
  if (S.cam) safe("restore camera", () => setCam(S.cam.p, S.cam.alt, S.cam.b, S.cam.t));
  renderShapes(); renderGrid(); updateCam(); updateHud(); setMode(S.mode, true);
  map3.on("moveend", () => {
    S.view = {center: map3.getCenter().toArray(), zoom: map3.getZoom(), bearing: map3.getBearing(), pitch: map3.getPitch()};
    const c = getCam(); S.cam = {p: c.p, alt: c.alt, b: c.b, t: c.t};
    save(); renderGrid(); loadTrees();
  });
  map3.on("move", updateCam);
  map3.on("idle", countNear);
  if (mapT) {
    mapT.on("moveend", renderGrid);
    map3.on("moveend", () => {          // keep the top map roughly on the 3D view
      const c = map3.getCenter(), b = mapT.getBounds();
      const inner = [b.getWest() + (b.getEast() - b.getWest()) * 0.2, b.getSouth() + (b.getNorth() - b.getSouth()) * 0.2,
                     b.getEast() - (b.getEast() - b.getWest()) * 0.2, b.getNorth() - (b.getNorth() - b.getSouth()) * 0.2];
      if (c.lng < inner[0] || c.lng > inner[2] || c.lat < inner[1] || c.lat > inner[3]) mapT.easeTo({center: c, duration: 400});
    });
  }
  loadTrees();
}

// ------------------------------------------------------------------ camera
// The camera is a point (lon, lat, altitude above sea level in m) with a heading (b, degrees) and a tilt
// (t, degrees: 0 = straight down, 90 = level, more = looking up). MapLibre still needs a "centre": we put it on the
// line of sight, on the ground when the camera looks down at it, otherwise a short distance ahead in the air.
const RAD = Math.PI / 180;
const ORBIT_ABOVE = 30;                           // higher than this above the ground, one finger orbits around the centre
let wanted = null;                                // the camera we asked for: kept even if MapLibre would lift it out of the ground
map3.transformCameraUpdate = () => wanted || {};
const groundAt = p => { if (!S.terrain) return 0; try { return map3.queryTerrainElevation(p) || 0; } catch { return 0; } };
function getCam() {
  const tr = map3.transform, ll = tr.getCameraLngLat();
  return {p: [ll.lng, ll.lat], alt: tr.getCameraAltitude(), b: map3.getBearing(), t: map3.getPitch()};
}
const heightAbove = c => c.alt - groundAt(c.p);
function setCam(p, alt, b, t, D) {
  t = Math.max(0, Math.min(150, t));
  const ground = groundAt(p), h = alt - ground;
  if (D == null) D = (t < 84 && h > 0) ? Math.min(h / Math.cos(t * RAD), 4000) : Math.max(12, Math.min(Math.abs(h) * 1.5, 400));
  const ctc = map3.transform.cameraToCenterDistance || map3.getCanvas().clientHeight * 1.5;
  const zoomOf = (d, lat) => Math.log2(ctc * 40075016.686 * Math.cos(lat * RAD) / (512 * d));
  D = Math.max(D, 1.02 * 40075016.686 * Math.cos(p[1] * RAD) * ctc / (512 * 2 ** 24));   // MapLibre's zoom stops at 24
  const horiz = D * Math.sin(t * RAD);
  const center = G.offset(p, horiz * Math.sin(b * RAD), horiz * Math.cos(b * RAD));
  wanted = {center: new maplibregl.LngLat(center[0], center[1]), zoom: Math.min(24, zoomOf(D, center[1])), pitch: t, bearing: b,
            elevation: alt - D * Math.cos(t * RAD)};
  try { map3.jumpTo(wanted); } finally { wanted = null; }
}
// Move the camera along the line through a screen point (forward when dist > 0). Never stops: you can fly through
// buildings and the ground.
function dolly(dist, sx, sy) {
  const c = getCam(), cv = map3.getCanvas(), ctc = map3.transform.cameraToCenterDistance || cv.clientHeight * 1.5;
  const yaw = sx == null ? 0 : Math.atan((sx - cv.clientWidth / 2) / ctc) / RAD;
  const tilt = sy == null ? 0 : Math.atan((sy - cv.clientHeight / 2) / ctc) / RAD;
  const b = c.b + yaw, t = c.t - tilt;
  const horiz = dist * Math.sin(t * RAD), up = -dist * Math.cos(t * RAD);
  setCam(G.offset(c.p, horiz * Math.sin(b * RAD), horiz * Math.cos(b * RAD)), c.alt + up, c.b, c.t);
}
const dollyStep = () => Math.max(1.5, Math.abs(heightAbove(getCam())));     // slower close to the ground, never zero
// Turn the view: high up, orbit around the centre; close to the ground, look around from where the camera is.
function turn(db, dt) {
  const c = getCam();
  if (heightAbove(c) > ORBIT_ABOVE && c.t < 89) {
    map3.jumpTo({bearing: c.b + db, pitch: Math.max(0, Math.min(88, c.t + dt))});
  } else setCam(c.p, c.alt, c.b + db, Math.max(0, Math.min(150, c.t + dt)));
}
function pan(dxPx, dyPx) {                         // move the camera level with the ground, like dragging the map
  const c = getCam(), cv = map3.getCanvas(), ctc = map3.transform.cameraToCenterDistance || cv.clientHeight * 1.5;
  const h = Math.max(2, Math.abs(heightAbove(c)));
  const D = c.t < 84 ? h / Math.max(0.15, Math.cos(c.t * RAD)) : h * 6;
  const mpp = D / ctc, k = 1 / Math.max(0.35, Math.cos(Math.min(c.t, 80) * RAD));
  const right = -dxPx * mpp, fwd = dyPx * mpp * k;
  const b = c.b * RAD;
  const p = G.offset(c.p, right * Math.cos(b) + fwd * Math.sin(b), -right * Math.sin(b) + fwd * Math.cos(b));
  setCam(p, c.alt, c.b, c.t);
}

// mouse wheel (PC): fly toward the point under the cursor
map3.getCanvasContainer().addEventListener("wheel", e => {
  e.preventDefault();
  const r = map3.getCanvas().getBoundingClientRect();
  const d = Math.max(-300, Math.min(300, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));
  dolly(-d / 100 * 0.18 * dollyStep() * (e.shiftKey ? 4 : 1), e.clientX - r.left, e.clientY - r.top);
}, {passive: false});

// touch (phone): one finger = turn / tilt, two fingers = move (slide) and zoom (pinch)
let editingNow = false;                            // set while the range editor owns the finger
(function touchCamera() {
  if (PC) return;
  const el = map3.getCanvasContainer();
  let last = null;
  const pts = e => [...e.touches].map(t => { const r = el.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; });
  el.addEventListener("touchstart", e => { last = pts(e); const h = $("#hintPhone"); if (h) setTimeout(() => h.remove(), 2500); }, {passive: true});
  el.addEventListener("touchmove", e => {
    if (editingNow) { last = pts(e); return; }
    const now = pts(e);
    if (!last || now.length !== last.length) { last = now; return; }
    e.preventDefault();
    if (now.length === 1) {
      turn(-(now[0][0] - last[0][0]) * 0.28, (now[0][1] - last[0][1]) * 0.22);   // the view follows the finger, like Street View
    } else if (now.length >= 2) {
      const mid = a => [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2], gap = a => Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
      const m0 = mid(last), m1 = mid(now), g0 = gap(last), g1 = gap(now);
      if (Math.abs(m1[0] - m0[0]) + Math.abs(m1[1] - m0[1]) > 0.5) pan(m1[0] - m0[0], m1[1] - m0[1]);
      if (g0 > 10 && Math.abs(g1 / g0 - 1) > 0.003) dolly((g1 / g0 - 1) * 2.2 * dollyStep(), m1[0], m1[1]);
    }
    last = now;
  }, {passive: false});
  el.addEventListener("touchend", e => { last = pts(e); }, {passive: true});
})();

// height / tilt readout and "back above the ground"
function updateHud() {
  const c = getCam(), h = heightAbove(c);
  $("#hudText").textContent = `高さ ${Math.abs(h) < 10 ? h.toFixed(1) : Math.round(h)}m・傾き ${Math.round(c.t)}°`;
  $("#toGround").hidden = h > 0.5;
}
map3.on("move", updateHud);
$("#toGround").addEventListener("click", () => { const c = getCam(); setCam(c.p, groundAt(c.p) + S.eyeH, c.b, 80); });

// presets: 真上 / 見下ろし / 目線 (where you look stays where it is)
function lookPoint() {
  const c = getCam();
  if (c.t < 84 && heightAbove(c) > 0) return map3.getCenter().toArray();
  return c.p;
}
function setMode(m, initial) {
  S.mode = m; save();
  $$("#viewseg b").forEach(b => b.classList.toggle("on", b.dataset.v === m));
  $("#walk").hidden = PC || m !== "eye";          // PC walks with the keyboard
  if (initial) return;
  const c = getCam(), target = lookPoint(), g = groundAt(target);
  const place = (H, t) => {             // camera H m above the target's ground, tilted t, looking at the target
    const D = H / Math.cos(t * RAD), horiz = D * Math.sin(t * RAD);
    setCam(G.offset(target, -horiz * Math.sin(c.b * RAD), -horiz * Math.cos(c.b * RAD)), g + H, c.b, t, D);
  };
  if (m === "top") place(Math.max(250, Math.min(2500, heightAbove(c))), 0);
  else if (m === "oblique") place(320, 58);
  else setCam(c.t < 84 && heightAbove(c) > 0 ? target : c.p, g + S.eyeH, c.b, 80);
}
$("#viewseg").addEventListener("click", e => { const v = e.target.dataset.v; if (v) setMode(v); });
function walk(cmd, fast) {
  const c = getCam(), step = (fast ? 4 : 1) * Math.max(3, Math.abs(heightAbove(c)) * 0.15);
  const r = c.b * RAD;
  let p = c.p, alt = c.alt, b = c.b;
  if (cmd === "fwd") p = G.offset(p, step * Math.sin(r), step * Math.cos(r));
  if (cmd === "back") p = G.offset(p, -step * Math.sin(r), -step * Math.cos(r));
  if (cmd === "left") p = G.offset(p, -step * Math.cos(r), step * Math.sin(r));
  if (cmd === "right") p = G.offset(p, step * Math.cos(r), -step * Math.sin(r));
  if (cmd === "turnL") b -= fast ? 30 : 8;
  if (cmd === "turnR") b += fast ? 30 : 8;
  if (cmd === "up") alt += step;
  if (cmd === "down") alt -= step;
  setCam(p, alt, b, c.t);
}
function setEyeH(h) { S.eyeH = Math.round(h * 10) / 10; $("#eyeh").value = S.eyeH; $("#eyehP").value = S.eyeH; save(); }
setEyeH(S.eyeH);
for (const id of ["#eyeh", "#eyehP"]) $(id).addEventListener("change", e => {
  setEyeH(Math.max(0.5, +e.target.value || 60));
  if (S.mode === "eye") { const c = getCam(); setCam(c.p, groundAt(c.p) + S.eyeH, c.b, c.t); }
});
let walkT = 0;
$("#walk").addEventListener("pointerdown", e => {
  const w = e.target.dataset.w; if (!w) return;
  e.preventDefault(); walk(w);
  clearInterval(walkT); walkT = setInterval(() => walk(w), 140);
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) $("#walk").addEventListener(ev, () => clearInterval(walkT));

// ------------------------------------------------------------------ ranges: drawing and editing
const colorOf = sh => LEVELS[sh.level].color;
function renderShapes() {
  const fs = S.shapes.map(sh => ({type: "Feature", properties: {id: sh.id, level: sh.level, color: colorOf(sh), sel: sh.id === sel}, geometry: {type: "Polygon", coordinates: [ringOf(sh)]}}));
  const s = S.shapes.find(x => x.id === sel);
  const hs = s ? handlesOf(s).map((h, i) => ({type: "Feature", properties: {i, type: h.type, color: colorOf(s)}, geometry: {type: "Point", coordinates: h.p}})) : [];
  for (const m of maps) {
    if (!m.getSource("shapes")) continue;
    m.getSource("shapes").setData({type: "FeatureCollection", features: fs});
    m.getSource("handles").setData({type: "FeatureCollection", features: hs});
  }
  renderLabels(); renderList(); renderSel(); renderEstimate();
}
const markers = [];
function renderLabels() {
  markers.splice(0).forEach(mk => mk.remove());
  for (const sh of S.shapes) for (const m of maps) {
    const el = document.createElement("div");
    el.className = "lbl"; el.style.background = colorOf(sh); if (sh.level !== "detail") el.style.color = "#fff";
    el.textContent = `${sh.name}（${LEVELS[sh.level].label}）`;
    const r = ringOf(sh), top = r.reduce((a, p) => p[1] > a[1] ? p : a, r[0]);
    markers.push(new maplibregl.Marker({element: el, anchor: "bottom"}).setLngLat(sh.kind === "circle" ? sh.c : top).addTo(m));
  }
}
function setDraft(sh) {
  const data = sh ? {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: ringOf(sh)}}]} : EMPTY;
  maps.forEach(m => m.getSource("draft") && m.getSource("draft").setData(data));
}
function setTool(t) {
  tool = t;
  $$("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  const hints = {select: "範囲をタップして選ぶ。角の印で大きさ、青い丸で回転、中をドラッグで移動。",
    rect: "地図をなぞって四角を置きます（タップだけなら 200×120m）。", circle: "中心からなぞって丸を置きます（タップだけなら半径 150m）。",
    box: "なぞった所の格子をまとめて選びます（タップで 1 マス）。"};
  $("#toolHint").textContent = hints[t];
  if (t === "box" && !S.showGrid) { S.showGrid = true; $("#gridOn").checked = true; renderGrid(); }
}
$$("[data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));

function addShape(sh) {
  const n = S.nextId++;
  sh.id = "r" + n; sh.name = sh.name || `範囲${n}`;
  sh.level = sh.level || (S.shapes.some(s => s.level === "detail") ? "mid" : "detail");
  S.shapes.push(sh); sel = sh.id; save(); renderShapes();
}
function attachEditor(m) {
  let drag = null, justDragged = false;
  const P = e => [e.lngLat.lng, e.lngLat.lat];
  const pad = e => { const r = PC ? 6 : 12; return [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]]; };
  function down(e) {
    const oe = e.originalEvent;
    if (oe.touches && oe.touches.length > 1) { if (drag) end(); return; }
    if (oe.button === 2) return;
    const p = P(e);
    if (tool !== "select") { drag = {type: "draw", start: p, moved: false}; return begin(e); }
    const s = S.shapes.find(x => x.id === sel);
    if (!s || !m.getLayer("handles")) return;
    const hf = m.queryRenderedFeatures(pad(e), {layers: ["handles"]});
    if (hf.length) { drag = {type: "handle", h: handlesOf(s)[hf[0].properties.i], start: p, orig: clone(s), moved: false}; return begin(e); }
    const sf = m.queryRenderedFeatures(e.point, {layers: ["shapes-fill"]});
    if (sf.some(f => f.properties.id === sel)) { drag = {type: "handle", h: {type: "move"}, start: p, orig: clone(s), moved: false}; return begin(e); }
  }
  let panWas = true, zoomWas = true;
  function begin(e) {
    e.preventDefault(); editingNow = true;
    panWas = m.dragPan.isEnabled(); zoomWas = m.touchZoomRotate.isEnabled();
    m.dragPan.disable(); m.touchZoomRotate.disable();
  }
  function move(e) {
    if (!drag) return;
    drag.moved = true;
    const p = P(e);
    if (drag.type === "draw") setDraft(drawShape(tool, drag.start, p, m.getBearing(), S.gridLevel));
    else {
      const i = S.shapes.findIndex(x => x.id === sel); if (i < 0) return;
      const ns = dragHandle(S.shapes[i], drag.h, p, drag.start, drag.orig);
      S.shapes[i] = Object.assign(ns, {id: drag.orig.id, name: S.shapes[i].name, level: S.shapes[i].level});
      renderShapes();
    }
  }
  function end(e) {
    if (!drag) return;
    const d = drag; drag = null; justDragged = true; setTimeout(() => justDragged = false, 50);
    editingNow = false;
    if (panWas) m.dragPan.enable(); if (zoomWas) m.touchZoomRotate.enable();
    setDraft(null);
    if (d.type === "draw") {
      const p = e && e.lngLat ? P(e) : d.start;
      let sh;
      if (!d.moved || G.dist(d.start, p) < 5) {
        if (tool === "rect") sh = drawShape("rect", G.offset(d.start, -100, -60), G.offset(d.start, 100, 60), 0, S.gridLevel), sh.ang = Math.round(-m.getBearing() * 10) / 10;
        else if (tool === "circle") sh = {kind: "circle", c: d.start, r: 150};
        else sh = drawShape("box", d.start, d.start, 0, S.gridLevel);
      } else sh = drawShape(tool, d.start, p, m.getBearing(), S.gridLevel);
      addShape(sh);
      if (!PC) setTool("select");
      if (!PC && $("#panel").classList.contains("min")) toast(`${S.shapes[S.shapes.length - 1].name} を置きました（下の「範囲」で細かさを変えられます）`);
    } else save();
  }
  m.on("mousedown", down); m.on("touchstart", down);
  m.on("mousemove", move); m.on("touchmove", move);
  m.on("mouseup", end); m.on("touchend", end); m.on("touchcancel", end);
  m.on("click", e => {
    if (justDragged || tool !== "select" || !m.getLayer("handles")) return;
    if (m.queryRenderedFeatures(pad(e), {layers: ["handles"]}).length) return;
    const f = m.queryRenderedFeatures(e.point, {layers: ["shapes-fill"]});
    const ids = f.map(x => x.properties.id);
    sel = ids.length ? (ids.includes(sel) && ids.length > 1 ? ids[(ids.indexOf(sel) + 1) % ids.length] : ids[0]) : null;
    renderShapes();
  });
}
maps.forEach(attachEditor);

// mesh grid lines in view
function renderGrid() {
  for (const m of maps) {
    if (!m.getSource("grid")) continue;
    const lvl = S.gridLevel, minZ = lvl === 4 ? 13.2 : 11.8;
    if (!S.showGrid || m.getZoom() < minZ) { m.getSource("grid").setData(EMPTY); continue; }
    const b = m.getBounds(), [dn, dl] = G.meshStep(lvl), fs = [];
    const w = Math.floor(b.getWest() / dl) * dl, s = Math.floor(b.getSouth() / dn) * dn;
    for (let x = w; x <= b.getEast() + dl && fs.length < 600; x += dl) fs.push({type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: [[x, b.getSouth() - dn], [x, b.getNorth() + dn]]}});
    for (let y = s; y <= b.getNorth() + dn && fs.length < 1200; y += dn) fs.push({type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: [[b.getWest() - dl, y], [b.getEast() + dl, y]]}});
    m.getSource("grid").setData({type: "FeatureCollection", features: fs});
  }
}
// camera of the 3D view on the top map
function updateCam() {
  if (!mapT || !mapT.getSource("cam")) return;
  const c = getCam(), r = c.b * RAD, cam = c.p;
  const L = Math.max(120, Math.min(1500, Math.abs(heightAbove(c)) * (c.t < 80 ? 2.5 * Math.tan(Math.max(c.t, 20) * RAD) : 8)));
  const a1 = r - 0.42, a2 = r + 0.42;
  const cone = [cam, G.offset(cam, L * Math.sin(a1), L * Math.cos(a1)), G.offset(cam, L * Math.sin(a2), L * Math.cos(a2)), cam];
  mapT.getSource("cam").setData({type: "FeatureCollection", features: [
    {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [cone]}},
    {type: "Feature", properties: {}, geometry: {type: "Point", coordinates: cam}}]});
}

// ------------------------------------------------------------------ trees near the view (3D only, small Overpass query, cached)
const treeCells = new Map();
let treeBusy = false, treeLast = 0;
async function loadTrees() {
  if (!S.trees || !map3.getSource("trees")) return;
  if (map3.getZoom() < 15.3) return;
  const c = map3.getCenter(), code = G.meshCode(c.lat, c.lng, 4);
  if (treeCells.has(code) || treeBusy || Date.now() - treeLast < 2500) return;
  treeBusy = true; treeLast = Date.now();
  try {
    const [w, s, e, n] = G.meshBounds(code);
    const q = `[out:json][timeout:25];node["natural"="tree"](${s},${w},${n},${e});out qt;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {method: "POST", body: "data=" + encodeURIComponent(q), headers: {"Content-Type": "application/x-www-form-urlencoded"}});
    const js = res.ok ? await res.json() : {elements: []};
    treeCells.set(code, (js.elements || []).map(el => {
      const ring = []; for (let i = 0; i <= 8; i++) ring.push(G.offset([el.lon, el.lat], 2.6 * Math.cos(i / 8 * 2 * Math.PI), 2.6 * Math.sin(i / 8 * 2 * Math.PI)));
      return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [ring]}};
    }));
    map3.getSource("trees").setData({type: "FeatureCollection", features: [...treeCells.values()].flat()});
  } catch {} finally { treeBusy = false; }
}

// buildings near the centre (from the tiles already shown)
function countNear() {
  if (!map3.getSource("omt")) { $("#nearCount").textContent = "（建物データなし）"; return; }
  if (map3.getZoom() < 14) { $("#nearCount").textContent = "（もう少し寄ると数えます）"; return; }
  const c = map3.getCenter().toArray(), seen = new Set();
  let n = 0;
  for (const f of map3.querySourceFeatures("omt", {sourceLayer: "building"})) {
    const g = f.geometry; if (!g || !g.coordinates) continue;
    const p = g.type === "Polygon" ? g.coordinates[0][0] : g.type === "MultiPolygon" ? g.coordinates[0][0][0] : null;
    if (!p) continue;
    const k = p[0].toFixed(6) + "," + p[1].toFixed(6);
    if (seen.has(k)) continue; seen.add(k);
    if (G.dist(c, p) < 500) n++;
  }
  $("#nearCount").textContent = `約 ${n.toLocaleString()} 棟`;
}

// ------------------------------------------------------------------ panel: list, selected range, estimate
const KIND_ICON = {rect: "▭", circle: "◯", box: "▦"};
function renderList() {
  $("#rangeCount").textContent = S.shapes.length ? `${S.shapes.length} つ` : "";
  $("#list").innerHTML = S.shapes.length ? S.shapes.map(sh => `<div class="it${sh.id === sel ? " sel" : ""}" data-id="${sh.id}">
    <div class="ic">${KIND_ICON[sh.kind]}</div><div><div class="nm">${esc(sh.name)}</div><div class="ds">${sizeText(sh)}</div></div>
    <span class="chip" style="background:${colorOf(sh)};${sh.level === "detail" ? "" : "color:#fff"}">${LEVELS[sh.level].label}</span></div>`).join("")
    : `<div class="empty">まだありません。上の「四角・丸・格子」で地図に置いてください。</div>`;
}
$("#list").addEventListener("click", e => {
  const it = e.target.closest(".it"); if (!it) return;
  sel = it.dataset.id; renderShapes();
  const sh = S.shapes.find(x => x.id === sel), b = bboxOfShape(sh);
  for (const m of maps) m.fitBounds([[b[0], b[1]], [b[2], b[3]]], {padding: 60, maxZoom: 17, duration: 500, ...(m === map3 && S.mode !== "top" ? {pitch: m.getPitch()} : {})});
});
function renderSel() {
  const sh = S.shapes.find(x => x.id === sel);
  if (!sh) { $("#selbox").innerHTML = ""; return; }
  let size = "";
  if (sh.kind === "rect") size = `<div class="row"><span>大きさ</span><span><input type="number" data-f="w" value="${Math.round(sh.w)}"> × <input type="number" data-f="h" value="${Math.round(sh.h)}"> m</span></div>
    <div class="row"><span>向き</span><span><input type="number" data-f="ang" value="${sh.ang}"> °</span></div>`;
  else if (sh.kind === "circle") size = `<div class="row"><span>半径</span><span><input type="number" data-f="r" value="${Math.round(sh.r)}"> m</span></div>`;
  else { const [w, h] = boxSize(sh); size = `<div class="row"><span>大きさ</span><b>${fmtM(w)} × ${fmtM(h)}</b></div>`; }
  $("#selbox").innerHTML = `<div class="row"><input type="text" data-f="name" value="${esc(sh.name)}"></div>
    <div class="seg" id="lvseg">${Object.entries(LEVELS).map(([k, v]) => `<b class="lv-${k}${sh.level === k ? " on" : ""}" data-lv="${k}">${v.label}</b>`).join("")}</div>
    ${size}<div class="row"><span>面積</span><b>${(areaOf(sh) / 1e6).toFixed(areaOf(sh) < 1e6 ? 3 : 2)} km²</b></div>
    <div class="row2"><button class="ib wide" data-act="dup">複製</button><button class="ib wide" data-act="del" style="color:var(--bad)">消す</button><button class="ib wide" data-act="done">完了</button></div>`;
}
$("#selbox").addEventListener("click", e => {
  const sh = S.shapes.find(x => x.id === sel); if (!sh) return;
  if (e.target.dataset.lv) { sh.level = e.target.dataset.lv; save(); renderShapes(); }
  const act = e.target.dataset.act;
  if (act === "del") delShape();
  if (act === "dup") dupShape();
  if (act === "done") { sel = null; renderShapes(); }
});
$("#selbox").addEventListener("change", e => {
  const sh = S.shapes.find(x => x.id === sel), f = e.target.dataset.f; if (!sh || !f) return;
  if (f === "name") sh.name = e.target.value.trim() || sh.name;
  else { const v = parseFloat(e.target.value); if (isFinite(v)) sh[f] = f === "ang" ? v : Math.max(20, v); }
  save(); renderShapes();
});
function delShape() { S.shapes = S.shapes.filter(x => x.id !== sel); sel = null; save(); renderShapes(); }
function dupShape() {
  const sh = S.shapes.find(x => x.id === sel); if (!sh) return;
  const c = clone(sh); delete c.id; c.name = sh.name + "の複製";
  if (c.kind === "box") { const dl = c.b[2] - c.b[0]; c.b = [c.b[0] + dl, c.b[1], c.b[2] + dl, c.b[3]]; } else c.c = G.offset(c.c, 60, -60);
  addShape(c);
}

function renderEstimate() {
  const by = {detail: [], mid: [], far: []};
  for (const sh of S.shapes) if (by[sh.level]) by[sh.level].push(sh);
  const cells = (list, lvl) => { const set = new Set(); for (const sh of list) { const r = ringOf(sh); for (const c of G.meshCells(bboxOfShape(sh), lvl)) { if (G.ringTouchesBox(G.meshBounds(c), r)) set.add(c); } } return set.size; };
  const nd = cells(by.detail, 4), nm = cells(by.mid, 3), nf = by.far.length + (S.outside === "far" ? 1 : 0);
  const area = l => l.reduce((s, sh) => s + areaOf(sh), 0) / 1e6;
  const mb = nd * 1.6 + nm * 0.7 + (area(by.far) + (S.outside === "far" ? Math.PI * (S.outsideR / 1000) ** 2 : 0)) * 0.12;
  $("#estimate").innerHTML = `<div class="kv"><span>詳細（約500m の区画）</span><b>${nd} 区画</b></div>
    <div class="kv"><span>中景（約1km の区画）</span><b>${nm} 区画</b></div>
    <div class="kv"><span>板ポリ</span><b>${nf} つ</b></div>
    <div class="kv"><span>ファイルの大きさ（目安）</span><b>約 ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB</b></div>
    ${nd > 12 ? `<p class="note" style="color:#ffcf8a">詳細の区画が多いので、OSM の取得に時間がかかります（1 区画 数秒〜数十秒）。</p>` : ""}`;
}

// ------------------------------------------------------------------ panel: settings, tabs
function bindSeg(id, key, attr, after) {
  const el = $(id);
  const paint = () => $$(id + " b").forEach(b => b.classList.toggle("on", String(S[key]) === b.dataset[attr]));
  el.addEventListener("click", e => { const v = e.target.dataset[attr]; if (v == null) return; S[key] = isNaN(+v) ? v : +v; save(); paint(); after && after(); });
  paint();
}
bindSeg("#baseseg", "base", "b", () => maps.forEach(m => {
  m.setLayoutProperty("pale", "visibility", S.base === "map" ? "visible" : "none");
  m.setLayoutProperty("photo", "visibility", S.base === "photo" ? "visible" : "none");
  if (m === mapT && m.getLayer("bld")) m.setPaintProperty("bld", "fill-opacity", S.base === "photo" ? 0.35 : 0.9);
}));
bindSeg("#gridseg", "gridLevel", "g", renderGrid);
bindSeg("#outseg", "outside", "o", () => { $("#outRrow").style.display = S.outside === "far" ? "" : "none"; renderEstimate(); });
$("#outRrow").style.display = S.outside === "far" ? "" : "none";
const bindCheck = (id, key, after) => { $(id).checked = !!S[key]; $(id).addEventListener("change", e => { S[key] = e.target.checked; save(); after && after(); }); };
bindCheck("#terrainOn", "terrain", applyTerrain);
bindCheck("#treesOn", "trees", () => { if (!S.trees) map3.getSource("trees").setData(EMPTY); else loadTrees(); });
bindCheck("#gridOn", "showGrid", renderGrid);
$("#fog").value = String(S.fog); $("#fog").addEventListener("change", e => { S.fog = +e.target.value; save(); applySky(); });
$("#outR").value = String(S.outsideR); $("#outR").addEventListener("change", e => { S.outsideR = +e.target.value; save(); renderEstimate(); });

function setTab(t) {
  $$("#tabs b").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  $$("#pages section").forEach(s => s.classList.toggle("on", s.dataset.p === t));
  $("#panel").classList.remove("min");
}
$("#tabs").addEventListener("click", e => { if (e.target.dataset.t) setTab(e.target.dataset.t); });
$("#grab").addEventListener("click", () => $("#panel").classList.toggle("min"));
if (!PC) { setTab("place"); $("#panel").classList.add("min"); }

function setPlace(name, c) {
  S.place = {name, c}; save();
  $("#placeName").textContent = name;
  $("#placeSub").textContent = `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`;
}
setPlace(S.place.name, S.place.c);

// ------------------------------------------------------------------ search and current position
async function search(q) {
  const box = $("#results");
  const m = q.match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/) || q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) { const a = +m[1], b = +m[2], lat = Math.abs(a) <= 90 && a < b ? a : b, lon = lat === a ? b : a; return go(`${lat.toFixed(5)}, ${lon.toFixed(5)}`, [lon, lat]); }
  box.innerHTML = `<div class="mu">探しています…</div>`; box.classList.add("on");
  const out = [];
  try {
    const r = await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q));
    for (const f of (await r.json()).slice(0, 8)) out.push({name: f.properties.title, sub: "国土地理院", c: f.geometry.coordinates});
  } catch {}
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`);
    for (const f of await r.json()) out.push({name: f.display_name.split(",")[0], sub: f.display_name.split(",").slice(1, 4).join(","), c: [+f.lon, +f.lat]});
  } catch {}
  box.innerHTML = out.length ? out.map((o, i) => `<div data-i="${i}">${esc(o.name)}<small>${esc(o.sub)}</small></div>`).join("") : `<div class="mu">見つかりませんでした</div>`;
  box.onclick = e => { const d = e.target.closest("[data-i]"); if (!d) return; const o = out[+d.dataset.i]; go(o.name, o.c); };
}
function go(name, c) {
  $("#results").classList.remove("on"); $("#q").blur();
  setPlace(name, c);
  if (S.mode === "eye") {               // the ground height there is known only once its terrain tiles are in
    map3.jumpTo({center: c, zoom: 17, pitch: 60, elevation: 0});
    map3.once("idle", () => setCam(c, groundAt(c) + S.eyeH, map3.getBearing(), 80));
  } else map3.flyTo({center: c, zoom: S.mode === "top" ? 15.5 : 16.4, pitch: S.mode === "top" ? 0 : 58, elevation: 0, duration: 1200});
  if (mapT) mapT.jumpTo({center: c, zoom: 15.2});
}
$("#q").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.value.trim()) search(e.target.value.trim()); });
document.addEventListener("click", e => { if (!e.target.closest(".searchbox")) $("#results").classList.remove("on"); });
$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("この端末では現在地が使えません");
  navigator.geolocation.getCurrentPosition(p => go("現在地", [p.coords.longitude, p.coords.latitude]),
    () => toast("現在地が取れませんでした（ブラウザの位置情報の許可を確認してください）"), {enableHighAccuracy: true, timeout: 10000});
});

// ------------------------------------------------------------------ save / open ranges, export
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const safeName = s => (s || "rokehan").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
async function deliver(blob, name, label) {
  const file = new File([blob], name, {type: blob.type});
  const box = $("#result");
  box.innerHTML = "";
  if (navigator.canShare && navigator.canShare({files: [file]})) {
    const b = document.createElement("button"); b.className = "pr wide"; b.textContent = `${label}を共有（pCloud に保存）`;
    b.onclick = () => navigator.share({files: [file], title: name}).catch(() => {});
    box.appendChild(b);
  }
  const a = document.createElement("a"); a.className = "ib wide"; a.textContent = `${label}をダウンロード（${(blob.size / 1048576).toFixed(1)} MB）`;
  a.href = URL.createObjectURL(blob); a.download = name; box.appendChild(a);
  const p = document.createElement("p"); p.className = "note";
  p.textContent = "pCloud の受け取りフォルダ（_Rokehan）に保存してください。PC で Claude が Blender で組み立てます。";
  box.appendChild(p);
}
function rangesFile() { return {app: "haikei-rokehan", version: 1, saved: new Date().toISOString(), place: S.place, view: S.view, outside: S.outside, outsideR: S.outsideR, shapes: S.shapes}; }
async function saveRanges() {
  setTab("export");
  const blob = new Blob([JSON.stringify(rangesFile(), null, 1)], {type: "application/json"});
  await deliver(blob, `範囲_${safeName(S.place.name)}_${stamp()}.json`, "範囲のファイル");
}
function openRanges(text) {
  try {
    let j = JSON.parse(text);
    if (j.format === "haikei-rokehan") j = {shapes: j.ranges.filter(r => r.shape).map(r => r.shape), place: j.place, outside: j.settings.outside, outsideR: j.settings.outsideR};
    if (!Array.isArray(j.shapes)) throw new Error("範囲のファイルではありません");
    S.shapes = j.shapes; S.nextId = Math.max(S.nextId, ...j.shapes.map(s => +String(s.id).replace(/\D/g, "") + 1 || 1));
    if (j.outside) S.outside = j.outside; if (j.outsideR) S.outsideR = j.outsideR;
    if (j.place) setPlace(j.place.name, j.place.c);
    sel = null; save(); renderShapes();
    const all = G.bboxOf(S.shapes.flatMap(ringOf));
    if (S.shapes.length) maps.forEach(m => m.fitBounds([[all[0], all[1]], [all[2], all[3]]], {padding: 50, duration: 600}));
    toast(`範囲を ${S.shapes.length} つ読み込みました`);
  } catch (e) { toast("開けませんでした: " + e.message); }
}
for (const id of ["#saveBtn", "#saveBtnPC"]) $(id).addEventListener("click", saveRanges);
for (const id of ["#openBtn", "#openBtnPC"]) $(id).addEventListener("click", () => $("#openFile").click());
$("#openFile").addEventListener("change", async e => { const f = e.target.files[0]; if (f) openRanges(await f.text()); e.target.value = ""; });

let exporting = false;
async function runExport() {
  setTab("export");
  if (exporting) return;
  if (!S.shapes.some(s => s.level !== "none")) return toast("先に作る範囲を置いてください");
  exporting = true;
  $("#exportBtn").disabled = true; $("#prog").hidden = false; $("#log").textContent = ""; $("#result").innerHTML = "";
  const log = m => { $("#log").textContent += m + "\n"; $("#log").scrollTop = 1e9; };
  try {
    const src = map3.getSource("omt");
    const {blob, manifest} = await exportData({shapes: S.shapes, place: S.place, omtTiles: src && src.tiles && src.tiles[0],
      settings: {outside: S.outside, outsideR: S.outsideR, terrain: $("#incTerrain").checked},
      onProgress: (msg, f) => { $("#progText").textContent = msg; $("#prog .bar b").style.width = Math.round(f * 100) + "%"; }, log});
    window.__lastExport = {blob, manifest};
    await deliver(blob, `rokehan_${safeName(S.place.name)}_${stamp()}.zip`, "データ");
  } catch (e) {
    log("エラー: " + (e && e.message || e)); toast("書き出しに失敗しました: " + (e && e.message || e), 5000);
  } finally { exporting = false; $("#exportBtn").disabled = false; }
}
for (const id of ["#exportBtn", "#exportBtnPC"]) $(id).addEventListener("click", runExport);

// ------------------------------------------------------------------ keyboard (PC)
const held = new Set();
document.addEventListener("keydown", e => {
  if (e.target.matches && e.target.matches("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if (k === "escape") { setTool("select"); sel = null; renderShapes(); return; }
  if ((k === "delete" || k === "backspace") && sel) { e.preventDefault(); delShape(); return; }
  if (k === "d" && (e.ctrlKey || e.metaKey) && sel) { e.preventDefault(); dupShape(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const walkKeys = {w: "fwd", s: "back", a: "left", d: "right", q: "turnL", e: "turnR", z: "up", x: "down", arrowup: "fwd", arrowdown: "back", arrowleft: "turnL", arrowright: "turnR"};
    if (walkKeys[k]) { e.preventDefault(); walk(walkKeys[k], e.shiftKey); return; }
    if (k === "r") setTool("rect"); else if (k === "c") setTool("circle"); else if (k === "g") setTool("box"); else if (k === "v") setTool("select");
    else if (k === "f") { map3.easeTo({center: S.place.c, duration: 600}); }
  }
});

setTool("select");
renderList(); renderSel(); renderEstimate();
window.__app = {S, setMode, walk, runExport, addShape, renderShapes, setCam, getCam, dolly, turn, pan, groundAt, get sel() { return sel; }};
