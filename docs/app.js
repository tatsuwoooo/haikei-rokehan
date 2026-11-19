// 背景ロケハン: pick a place in 3D, place ranges (rect / circle / mesh grid), export the data for Blender.
// One page for phone and PC: the PC layout adds a top-down map next to the 3D view.
import * as G from "./lib/geo.js?v=202611200101";
import { registerGsiDem } from "./lib/gsidem.js?v=202611200101";
import { LEVELS, ringOf, handlesOf, dragHandle, drawShape, sizeText, centerOf, areaOf, fmtM, boxSize, bboxOfShape } from "./lib/shapes.js?v=202611200101";
import { exportData, OMT_TILEJSON, overpass } from "./lib/export.js?v=202611200101";
import { omtArea } from "./lib/omttile.js?v=202611200101";
import { ROAD, autoProps, treesFor } from "./lib/props.js?v=202611200101";
import { photoMask } from "./lib/phototrees.js?v=202611200101";
import { unzip } from "./lib/zip.js?v=202611200101";
import { placeName } from "./lib/gsiname.js?v=202611200101";
import { gsiBuildings, makeLookup, guessHeight, KIND_OF_CODE, KIND_LABEL } from "./lib/gsibldg.js?v=202611200101";

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
  base: "photo", terrain: true, trees: true, fog: 1, eyeH: 60, gridLevel: 4, showGrid: true,
  outside: "none", outsideR: 2000, shapes: [], favs: [], nextId: 1, near: true, look: true, moveQ: 0.25, nearR: PC ? 400 : 250,      // phones draw a smaller circle by kind (lighter)
};
let S;
try { S = Object.assign(clone(DEF), JSON.parse(localStorage.getItem("rokehan") || "{}")); } catch { S = clone(DEF); }
if (!S.photoDefault) { S.base = "photo"; S.photoDefault = 1; }      // 2026-11-19: the photo became the default view (once, for saved settings too)
if (!S.moveQ2) { if (S.moveQ === 0.5) S.moveQ = 0.25; S.moveQ2 = 1; }   // 2026-11-20: much coarser while moving (once, for the old default too)
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
  canvasContextAttributes: {antialias: PC},
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
  for (const id of ["grid", "shapes", "handles", "draft", "trees", "cam", "near"]) m.addSource(id, {type: "geojson", data: EMPTY});
  if (role === "3d") m.addLayer({id: "near", type: "fill-extrusion", source: "near", minzoom: 13,
    paint: {"fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "top"], "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": 0.97, "fill-extrusion-vertical-gradient": true}});
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
  m.addLayer({id: "levers", type: "line", source: "handles", filter: ["==", ["geometry-type"], "LineString"],
    paint: {"line-color": ["get", "color"], "line-width": 2.5}});
  m.addLayer({id: "handles", type: "circle", source: "handles", filter: ["==", ["geometry-type"], "Point"], paint: {
    "circle-radius": ["case", ["==", ["get", "type"], "rotate"], PC ? 9 : 13, PC ? 7 : 10], "circle-color": ["case", ["==", ["get", "type"], "rotate"], ["get", "color"], "#ffffff"],
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
    save(); renderGrid(); loadOsm();
  });
  map3.on("move", updateCam);
  map3.on("idle", countNear);
  map3.on("idle", () => loadNear());
  if (mapT) {
    mapT.on("moveend", renderGrid);
    map3.on("moveend", () => {          // keep the top map roughly on the 3D view
      const c = map3.getCenter(), b = mapT.getBounds();
      const inner = [b.getWest() + (b.getEast() - b.getWest()) * 0.2, b.getSouth() + (b.getNorth() - b.getSouth()) * 0.2,
                     b.getEast() - (b.getEast() - b.getWest()) * 0.2, b.getNorth() - (b.getNorth() - b.getSouth()) * 0.2];
      if (c.lng < inner[0] || c.lng > inner[2] || c.lat < inner[1] || c.lat > inner[3]) mapT.easeTo({center: c, duration: 400});
    });
  }
  loadOsm();
}

// ------------------------------------------------------------------ camera
// The camera is a point (lon, lat, altitude above sea level in m) with a heading (b, degrees) and a tilt
// (t, degrees: 0 = straight down, 90 = level, more = looking up). MapLibre still needs a "centre": we put it on the
// line of sight, on the ground when the camera looks down at it, otherwise a short distance ahead in the air.
const RAD = Math.PI / 180;
let wanted = null;                                // the camera we asked for: kept even if MapLibre would lift it out of the ground
map3.transformCameraUpdate = () => wanted || {};
const groundAt = p => { if (!S.terrain) return 0; try { return map3.queryTerrainElevation(p) || 0; } catch { return 0; } };
function getCam() {
  const tr = map3.transform, ll = tr.getCameraLngLat();
  return {p: [ll.lng, ll.lat], alt: tr.getCameraAltitude(), b: map3.getBearing(), t: map3.getPitch()};
}
const heightAbove = c => c.alt - groundAt(c.p);
// While the camera is moving, the 3D view is drawn with fewer pixels (S.moveQ of the screen's own sharpness on
// each side, so 0.25 = a sixteenth of the pixels) and goes back to sharp shortly after it stops. A single jump (a button,
// GPS) stays sharp: only moves that come in quick succession count. A finger or mouse button still held keeps it coarse.
let coarse = false, coarseT = 0, lastCam = 0, holding = 0;
const sharpRatio = () => window.devicePixelRatio || 1;
function moving() {
  const now = performance.now(), quick = now - lastCam < 150;
  lastCam = now;
  if (!(S.moveQ < 1)) return;
  if (!coarse && quick) { coarse = true; map3.setPixelRatio(Math.max(0.15, sharpRatio() * S.moveQ)); }
  if (coarse) { clearTimeout(coarseT); coarseT = setTimeout(sharpen, 200); }
}
function sharpen() {
  if (!coarse) return;
  if (holding) { coarseT = setTimeout(sharpen, 120); return; }
  coarse = false; map3.setPixelRatio(sharpRatio());
}
function setCam(p, alt, b, t, D) {
  moving();
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
function dolly(dist, sx, sy) { const n = dollyFrom(getCam(), dist, sx, sy); setCam(n.p, n.alt, n.b, n.t); }
function dollyFrom(c, dist, sx, sy) {
  const cv = map3.getCanvas(), ctc = map3.transform.cameraToCenterDistance || cv.clientHeight * 1.5;
  const yaw = sx == null ? 0 : Math.atan((sx - cv.clientWidth / 2) / ctc) / RAD;
  const tilt = sy == null ? 0 : Math.atan((sy - cv.clientHeight / 2) / ctc) / RAD;
  const b = c.b + yaw, t = c.t - tilt;
  const horiz = dist * Math.sin(t * RAD), up = -dist * Math.cos(t * RAD);
  return {p: G.offset(c.p, horiz * Math.sin(b * RAD), horiz * Math.cos(b * RAD)), alt: c.alt + up, b: c.b, t: c.t};
}
const dollyStep = () => Math.max(1.5, Math.abs(heightAbove(getCam())));     // slower close to the ground, never zero
// Orbit, the same feel as どこでもロケハン (three.js OrbitControls): the point you look at is fixed when the drag starts,
// and the camera goes round it. Dragging the height of the screen turns it once around; dragging right turns the scene
// with the finger, dragging down looks more from above. It may go under the ground (「地上に戻る」 brings it back).
function orbitStart() {
  const c = getCam(), h = heightAbove(c);
  const D = (c.t < 84 && h > 0) ? Math.min(h / Math.cos(c.t * RAD), 4000) : Math.max(12, Math.min(Math.abs(h) * 1.5, 400));
  const ph = D * Math.sin(c.t * RAD);
  return {pivot: G.offset(c.p, ph * Math.sin(c.b * RAD), ph * Math.cos(c.b * RAD)), pivotAlt: c.alt - D * Math.cos(c.t * RAD), D, b: c.b, t: c.t};
}
function orbitTo(o, dxPx, dyPx) {
  const H = map3.getCanvas().clientHeight || 600;
  const b = o.b - 360 * dxPx / H, t = Math.max(0, Math.min(150, o.t - 360 * dyPx / H));
  const nh = o.D * Math.sin(t * RAD);
  setCam(G.offset(o.pivot, -nh * Math.sin(b * RAD), -nh * Math.cos(b * RAD)), o.pivotAlt + o.D * Math.cos(t * RAD), b, t, o.D);
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

// Two fingers on the phone: move the camera across the screen. Left-right: the scene follows the fingers (as pan above).
// Up-down: the scene follows the fingers too, so the camera goes the other way (2026-11-20 user request: slide up =
// pan down, slide down = pan up), along the screen's own up direction (straight up and down when looking level,
// forward and back when looking straight down).
function panView(dxPx, dyPx) { const n = panViewFrom(getCam(), dxPx, dyPx); setCam(n.p, n.alt, n.b, n.t); }
function panViewFrom(c, dxPx, dyPx) {
  const cv = map3.getCanvas(), ctc = map3.transform.cameraToCenterDistance || cv.clientHeight * 1.5;
  const h = Math.max(2, Math.abs(heightAbove(c)));
  const D = c.t < 84 ? h / Math.max(0.15, Math.cos(c.t * RAD)) : h * 6;
  const mpp = D / ctc;
  const right = -dxPx * mpp, up = dyPx * mpp;
  const fwd = up * Math.cos(c.t * RAD), rise = up * Math.sin(c.t * RAD);
  const b = c.b * RAD;
  return {p: G.offset(c.p, right * Math.cos(b) + fwd * Math.sin(b), -right * Math.sin(b) + fwd * Math.cos(b)), alt: c.alt + rise, b: c.b, t: c.t};
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
  let last = null, orb = null, two = null;
  const pts = e => [...e.touches].map(t => { const r = el.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; });
  el.addEventListener("touchstart", e => { last = pts(e); orb = null; two = null; holding = e.touches.length; const h = $("#hintPhone"); if (h) setTimeout(() => h.remove(), 2500); }, {passive: true});
  el.addEventListener("touchmove", e => {
    if (editingNow) { last = pts(e); orb = null; two = null; return; }
    const now = pts(e);
    if (!last || now.length !== last.length) { last = now; return; }
    e.preventDefault();
    if (now.length === 1) {
      if (!orb) orb = {o: orbitStart(), x: last[0][0], y: last[0][1]};
      orbitTo(orb.o, now[0][0] - orb.x, now[0][1] - orb.y);
    } else if (now.length >= 2) {
      orb = null;
      const mid = a => [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2], gap = a => Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
      const m0 = mid(last), m1 = mid(now), g0 = gap(last), g1 = gap(now);
      if (!two) two = getCam();                     // kept here during the gesture: reading the camera back each time drifts
      let moved = false;
      if (Math.abs(m1[0] - m0[0]) + Math.abs(m1[1] - m0[1]) > 0.5) { two = panViewFrom(two, m1[0] - m0[0], m1[1] - m0[1]); moved = true; }
      if (g0 > 10 && Math.abs(g1 / g0 - 1) > 0.003) {
        two = dollyFrom(two, (g1 / g0 - 1) * 2.2 * Math.max(1.5, Math.abs(two.alt - groundAt(two.p))), m1[0], m1[1]); moved = true;
      }
      if (moved) setCam(two.p, two.alt, two.b, two.t);
    }
    last = now;
  }, {passive: false});
  el.addEventListener("touchend", e => { last = pts(e); orb = null; two = null; holding = e.touches.length; }, {passive: true});
  el.addEventListener("touchcancel", () => { last = null; orb = null; two = null; holding = 0; }, {passive: true});
})();

// mouse (PC): left drag = orbit (as above), right drag = move. MapLibre's own dragging is switched off.
(function mouseCamera() {
  if (!PC) return;
  map3.dragPan.disable(); map3.dragRotate.disable();
  const el = map3.getCanvasContainer();
  let d = null;
  el.addEventListener("contextmenu", e => e.preventDefault());
  el.addEventListener("mousedown", e => {
    if (e.button !== 0 && e.button !== 2) return;
    d = {btn: e.button, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, o: null};
    holding = 1;
  });
  addEventListener("mousemove", e => {
    if (!d) return;
    if (editingNow) { d = null; return; }               // a range is being drawn or moved
    if (!d.on) { if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 3) return; d.on = true; if (d.btn === 0) d.o = orbitStart(); }
    if (d.btn === 0) orbitTo(d.o, e.clientX - d.x0, e.clientY - d.y0);
    else pan(e.clientX - d.x, e.clientY - d.y);
    d.x = e.clientX; d.y = e.clientY;
  });
  addEventListener("mouseup", () => { d = null; holding = 0; });
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
  const hl = s ? handlesOf(s) : [];
  const hs = hl.map((h, i) => ({type: "Feature", properties: {i, type: h.type, color: colorOf(s)}, geometry: {type: "Point", coordinates: h.p}}))
    .concat(hl.filter(h => h.from).map(h => ({type: "Feature", properties: {type: "lever", color: colorOf(s)}, geometry: {type: "LineString", coordinates: [h.from, h.p]}})));
  for (const m of maps) {
    if (!m.getSource("shapes")) continue;
    m.getSource("shapes").setData({type: "FeatureCollection", features: fs});
    m.getSource("handles").setData({type: "FeatureCollection", features: hs});
  }
  renderLabels(); renderList(); renderSel(); renderEstimate(); syncOverlay();
}
// The detailed view covers the map near the camera with its own ground, so it draws the range outlines, the one
// being drawn and the mesh grid itself.
let draftRing = null;
function syncOverlay() {
  if (!detail) return;
  const lines = [];
  const R = S.nearR + 40, t = nearAt;
  if (t && S.showGrid) {
    const [dn, dl] = G.meshStep(S.gridLevel), m = G.mPerDeg(t[1]);
    const w = t[0] - R / m.lon, e = t[0] + R / m.lon, s = t[1] - R / m.lat, n = t[1] + R / m.lat;
    for (let x = Math.floor(w / dl) * dl; x <= e; x += dl) lines.push({pts: [[x, s], [x, n]], color: "#3c3c5a", width: 0.6, dash: 4});
    for (let y = Math.floor(s / dn) * dn; y <= n; y += dn) lines.push({pts: [[w, y], [e, y]], color: "#3c3c5a", width: 0.6, dash: 4});
  }
  for (const sh of S.shapes) lines.push({pts: ringOf(sh), color: colorOf(sh), width: sh.id === sel ? 2.4 : 1.6, dash: sh.level === "far" ? 4 : 0});
  if (draftRing) lines.push({pts: draftRing, color: "#f39a2b", width: 2, dash: 3});
  detail.setOverlay(lines);
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
  draftRing = sh ? ringOf(sh) : null; syncOverlay();
}
function setTool(t) {
  tool = t;
  $$("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  const hints = {select: "範囲をタップして選ぶ。白い印で大きさ、棒の先の色の丸を回して回転、中をドラッグで移動（四角と扇）。",
    rect: "地図をなぞって四角を置きます（タップだけなら 200×120m）。", circle: "中心からなぞって丸を置きます（タップだけなら半径 150m）。",
    fan: "要（かなめ）の点から、広げたい向きへなぞって扇を置きます（開きは 60°。タップだけなら、見ている向きへ半径 300m）。先の白い印で長さ、両端で開き、棒の先の色の丸で回転。",
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
        else if (tool === "fan") sh = {kind: "fan", c: d.start, r: 300, dir: Math.round(((m.getBearing() % 360) + 360) % 360 * 10) / 10, spread: 60};
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
  syncOverlay();
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

// ------------------------------------------------------------------ buildings near the view, by kind (GSI)
// Inside a circle around where you look, the plain boxes are replaced by buildings drawn by kind (国土地理院の建物の種類):
// houses get a dark roof, concrete buildings and high-rises get floor lines. Heights come from the map data where it
// has a real value (OpenFreeMap gives 5 m when it does not know), otherwise a guess from the kind and the footprint.
const NEAR_STYLE = {
  house: {wall: "#efe5d3", roof: "#5d5452", roofT: 1.1},
  building: {wall: "#cfd4dc", roof: "#a3a9b4", roofT: 0.6, line: "#7f8796"},
  tower: {wall: "#b4c0d2", roof: "#8995a8", roofT: 0.8, line: "#6c788c"},
  shed: {wall: "#d6d6d6", roof: "#8d939b", roofT: 0.3},
};
const BLD_FILTER = ["!=", ["get", "hide_3d"], true];
let nearAt = null, nearBusy = false, nearAgain = false;
const feat = (rings, base, top, color) => ({type: "Feature", properties: {base, top, color}, geometry: {type: "Polygon", coordinates: rings}});
function clearNear() {
  nearAt = null;
  if (map3.getSource("near")) map3.getSource("near").setData(EMPTY);
  if (map3.getLayer("bld")) map3.setFilter("bld", BLD_FILTER);
  if (detail) detail.clear();
  if (map3.getLayer("trees")) map3.setLayoutProperty("trees", "visibility", "visible");
  renderNearLegend(null);
}
function renderNearLegend(counts) {
  $("#nearLegend").innerHTML = Object.entries(NEAR_STYLE).map(([k, v]) =>
    `<div class="lg"><i style="background:${v.wall};border-top:4px solid ${v.roof}"></i><span>${KIND_LABEL[k]}</span><b>${counts ? counts[k] || 0 : "—"}</b></div>`).join("");
}
async function loadNear(force) {
  if (!S.near || !map3.getSource("near")) return;
  const c = getCam(), target = lookPoint(), R = S.nearR;
  if (heightAbove(c) > 2500 || map3.getZoom() < 13.5) { if (nearAt) clearNear(); return; }
  if (!force && nearAt && G.dist(nearAt, target) < R * 0.35) return;
  if (nearBusy) { nearAgain = true; return; }
  nearBusy = true;
  try {
    const bb = [...G.offset(target, -R - 160, -R - 160), ...G.offset(target, R + 160, R + 160)];
    const tpl = OMT && OMT.tiles && OMT.tiles[0];
    const tbb = [...G.offset(target, -R - 25, -R - 25), ...G.offset(target, R + 25, R + 25)];
    const [list, area, mask] = await Promise.all([gsiBuildings(bb), tpl ? omtArea(tpl, bb) : {roads: [], buildings: [], green: []},
      S.trees && S.look ? photoMask(tbb).catch(() => null) : null]);
    if (!S.near) return;
    const omtAt = makeLookup(area.buildings);          // heights from the map data, matched by position
    const near = [], counts = {};
    for (const b of list) {
      const outer = b.rings[0], cen = G.ringCentroid(outer);
      if (G.dist(target, cen) > R && !outer.some(p => G.dist(target, p) < R)) continue;
      const kind = KIND_OF_CODE[b.code] || "building";
      const area2 = G.ringArea(outer.map(p => G.delta(outer[0], p)));
      const o = omtAt(cen);
      const h = o && o.h > 0 && o.h !== 5 ? o.h : guessHeight(kind, area2), base = o ? o.minH : 0;
      counts[kind] = (counts[kind] || 0) + 1;
      near.push({rings: b.rings, kind, h, base, area: area2});
    }
    const d = S.look ? await ensureDetail() : null;
    if (!S.near) return;
    if (d) {
      map3.getSource("near").setData(EMPTY);
      const inR = p => G.dist(target, p) < R + 25;
      const roads = area.roads.filter(r => r.pts.some(p => G.dist(target, p) < R + 150));      // (rails are drawn, but get no poles)
      const osm = osmNear(target, R + 160);
      const props = autoProps(roads, osm);
      const keep = o => inR(o.p);
      for (const k of ["poles", "lamps", "signals", "crossings"]) props[k] = props[k].filter(keep);
      props.wires = props.wires.filter(w => inR(w[0]) && inR(w[1]));
      const drawRoads = [];
      for (const r of roads) {                       // only the parts inside the circle
        let run = [];
        for (const p of r.pts) { if (inR(p)) run.push(p); else { if (run.length > 1) drawRoads.push({...r, pts: run}); run = []; } }
        if (run.length > 1) drawRoads.push({...r, pts: run});
      }
      const trees = !S.trees ? [] : treesFor({osmTrees: osm.trees, rows: osm.rows, green: area.green, roads: area.roads,
        inBuilding: makeLookup(list), mask, bbox: tbb, keep: inR, max: PC ? 9000 : 3500});
      window.__detailStats = d.build({origin: target, R, ground: groundAt, buildings: near, roads: drawRoads, props, trees, green: area.green, photo: S.base === "photo"});
      if (map3.getLayer("trees")) map3.setLayoutProperty("trees", "visibility", "none");
    } else {
      if (detail) detail.clear();
      if (map3.getLayer("trees")) map3.setLayoutProperty("trees", "visibility", "visible");
      const fs = [];
      for (const b of near) {
        const st = NEAR_STYLE[b.kind], outer = b.rings[0], cen = G.ringCentroid(outer), {h, base} = b;
        if (b.kind === "shed") { fs.push(feat(b.rings, base + 2.4, base + 2.4 + st.roofT, st.roof)); continue; }
        fs.push(feat(b.rings, base, base + h, st.wall));
        fs.push(feat(b.rings, base + h, base + h + st.roofT, st.roof));
        if (st.line) {                               // floor lines every 3.4 m, a little outside the wall (about 0.25 m)
          const k = 1 + 0.25 / Math.max(4, Math.sqrt(b.area));
          const ring = outer.map(p => [cen[0] + (p[0] - cen[0]) * k, cen[1] + (p[1] - cen[1]) * k]);
          for (let z = 3.4, n = 0; z < h - 1.5 && n < 45; z += 3.4, n++) fs.push(feat([ring], base + z - 0.13, base + z + 0.13, st.line));
        }
      }
      map3.getSource("near").setData({type: "FeatureCollection", features: fs});
    }
    if (map3.getLayer("bld")) map3.setFilter("bld", ["all", BLD_FILTER, [">", ["distance", {type: "Point", coordinates: target}], R]]);
    nearAt = target;
    syncOverlay();
    renderNearLegend(counts);
  } catch (e) { console.warn("near buildings", e); }
  finally { nearBusy = false; if (nearAgain) { nearAgain = false; setTimeout(() => loadNear(), 50); } }
}
// the detailed look (three.js) is loaded the first time it is needed
let detail = null, detailLoading = null;
function ensureDetail() {
  if (detail) return Promise.resolve(detail);
  if (!detailLoading) detailLoading = import("./lib/scene3d.js?v=202611200101").then(m => m.createDetail(map3, ROAD)).then(d => {
    map3.addLayer(d.layer, map3.getLayer("grid") ? "grid" : undefined);
    return (detail = d);
  }).catch(e => { console.warn("detail", e); toast("細かい見た目を読み込めませんでした（通信を確かめてください）"); detailLoading = null; return null; });
  return detailLoading;
}

// ------------------------------------------------------------------ OpenStreetMap things near the view (trees, signals, lamps, poles)
// One Overpass request for the 500 m cells around the view that are not loaded yet; kept for the session.
const osmCells = new Map();                        // 1/2 mesh code -> {trees, signals, lamps, poles, rows}
let osmBusy = false, osmLast = 0;
async function loadOsm() {
  if (!S.trees && !(S.near && S.look)) return;
  if (map3.getZoom() < 15.3 || heightAbove(getCam()) > 1500) return;
  const t = lookPoint(), R = (S.near ? S.nearR : 250) + 150;
  const cells = G.meshCells([...G.offset(t, -R, -R), ...G.offset(t, R, R)], 4).filter(c => !osmCells.has(c));
  if (!cells.length || osmBusy || Date.now() - osmLast < 2500) return;
  osmBusy = true; osmLast = Date.now();
  try {
    const bb = G.bboxOf(cells.flatMap(c => { const b = G.meshBounds(c); return [[b[0], b[1]], [b[2], b[3]]]; }));
    const box = `${bb[1]},${bb[0]},${bb[3]},${bb[2]}`;
    const q = `[out:json][timeout:30];(node["natural"="tree"](${box});node["highway"~"^(traffic_signals|street_lamp)$"](${box});` +
      `node["power"="pole"](${box});node["man_made"="utility_pole"](${box}););out qt;way["natural"="tree_row"](${box});out geom qt;`;
    const js = await overpass(q, () => {});
    for (const c of cells) osmCells.set(c, {trees: [], signals: [], lamps: [], poles: [], rows: []});
    for (const el of js.elements || []) {
      const p = el.type === "node" ? [el.lon, el.lat] : el.geometry && el.geometry.length ? [el.geometry[0].lon, el.geometry[0].lat] : null;
      if (!p) continue;
      const code = G.meshCode(p[1], p[0], 4);
      if (!cells.includes(code)) continue;
      const cell = osmCells.get(code), tg = el.tags || {};
      if (el.type === "way") cell.rows.push(el.geometry.map(g => [g.lon, g.lat]));
      else if (tg.natural === "tree") cell.trees.push(p);
      else if (tg.highway === "traffic_signals") cell.signals.push(p);
      else if (tg.highway === "street_lamp") cell.lamps.push(p);
      else cell.poles.push(p);
    }
    const all = [...osmCells.values()].flatMap(c => c.trees);
    map3.getSource("trees").setData({type: "FeatureCollection", features: all.map(p => {
      const ring = []; for (let i = 0; i <= 8; i++) ring.push(G.offset(p, 2.6 * Math.cos(i / 8 * 2 * Math.PI), 2.6 * Math.sin(i / 8 * 2 * Math.PI)));
      return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [ring]}};
    })});
    if (S.near && S.look) loadNear(true);
  } catch (e) { console.warn("osm", e); } finally { osmBusy = false; }
}
function osmNear(t, R) {
  const out = {trees: [], signals: [], lamps: [], poles: [], rows: []};
  for (const c of osmCells.values()) for (const k of Object.keys(out))
    for (const p of c[k]) if (k === "rows" ? p.some(q => G.dist(t, q) < R) : G.dist(t, p) < R) out[k].push(p);
  return out;
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
const KIND_ICON = {rect: "▭", circle: "◯", box: "▦", fan: "◔"};
function renderList() {
  $("#rangeCount").textContent = S.shapes.length ? `${S.shapes.length} つ` : "";
  $("#list").innerHTML = S.shapes.length ? S.shapes.map(sh => `<div class="it${sh.id === sel ? " sel" : ""}" data-id="${sh.id}">
    <div class="ic">${KIND_ICON[sh.kind]}</div><div><div class="nm">${esc(sh.name)}</div><div class="ds">${sizeText(sh)}</div></div>
    <span class="chip" style="background:${colorOf(sh)};${sh.level === "detail" ? "" : "color:#fff"}">${LEVELS[sh.level].label}</span></div>`).join("")
    : `<div class="empty">まだありません。上の「四角・丸・扇・格子」で地図に置いてください。</div>`;
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
  else if (sh.kind === "fan") size = `<div class="row"><span>半径</span><span><input type="number" data-f="r" value="${Math.round(sh.r)}"> m</span></div>
    <div class="row"><span>向き（北 0・東 90）</span><span><input type="number" data-f="dir" value="${Math.round(sh.dir)}"> °</span></div>
    <div class="row"><span>開き</span><span><input type="number" data-f="spread" value="${Math.round(sh.spread)}"> °</span></div>`;
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
  else {
    const v = parseFloat(e.target.value);
    if (isFinite(v)) sh[f] = f === "ang" ? v : f === "dir" ? ((v % 360) + 360) % 360 : f === "spread" ? Math.max(5, Math.min(360, v)) : Math.max(20, v);
  }
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
bindSeg("#baseseg", "base", "b", () => {
  maps.forEach(m => {
    m.setLayoutProperty("pale", "visibility", S.base === "map" ? "visible" : "none");
    m.setLayoutProperty("photo", "visibility", S.base === "photo" ? "visible" : "none");
    if (m === mapT && m.getLayer("bld")) m.setPaintProperty("bld", "fill-opacity", S.base === "photo" ? 0.35 : 0.9);
  });
  loadNear(true);                                  // over the photo, the detailed view leaves out its own ground and roads
});
bindSeg("#gridseg", "gridLevel", "g", renderGrid);
bindSeg("#outseg", "outside", "o", () => { $("#outRrow").style.display = S.outside === "far" ? "" : "none"; renderEstimate(); });
$("#outRrow").style.display = S.outside === "far" ? "" : "none";
const bindCheck = (id, key, after) => { $(id).checked = !!S[key]; $(id).addEventListener("change", e => { S[key] = e.target.checked; save(); after && after(); }); };
bindCheck("#terrainOn", "terrain", applyTerrain);
bindCheck("#treesOn", "trees", () => { if (!S.trees) map3.getSource("trees").setData(EMPTY); else loadOsm(); loadNear(true); });
bindCheck("#gridOn", "showGrid", renderGrid);
bindCheck("#nearOn", "near", () => { if (S.near) { loadNear(true); loadOsm(); } else clearNear(); });
bindCheck("#lookOn", "look", () => { loadNear(true); loadOsm(); });
$("#moveQ").value = String(S.moveQ);
$("#moveQ").addEventListener("change", e => { S.moveQ = +e.target.value; save(); });
$("#nearR").value = String(S.nearR);
$("#nearR").addEventListener("change", e => { S.nearR = +e.target.value; save(); loadNear(true); });
renderNearLegend(null);
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

// ------------------------------------------------------------------ favourites: the camera as it is now (position, height, direction, tilt)
// Kept in this browser (with the other settings) and in the range file, so they go between the phone and the PC too.
// The name is the rough place name from the GSI map labels (lib/gsiname.js: station / town / city); ✎ changes it.
async function addFav() {
  const c = getCam(), look = lookPoint();
  let base = null;
  try { base = await Promise.race([placeName(look), new Promise(r => setTimeout(() => r(null), 4000))]); } catch {}
  base = base || `お気に入り ${S.favs.length + 1}`;
  let name = base;
  for (let n = 2; S.favs.some(f => f.name === name); n++) name = `${base} ${n}`;
  const r = v => Math.round(v * 1e6) / 1e6;
  S.favs.unshift({id: "f" + Date.now().toString(36), name, cam: {p: [r(c.p[0]), r(c.p[1])], alt: Math.round(c.alt * 10) / 10,
    b: Math.round(c.b * 10) / 10, t: Math.round(c.t * 10) / 10, h: Math.round(heightAbove(c) * 10) / 10}, look: [r(look[0]), r(look[1])], mode: S.mode, saved: new Date().toISOString()});
  save(); renderFavs();
  toast(`「${name}」を登録しました（✎ で名前を変えられます）`, 3200);
}
function goFav(f) {
  const c = f.cam;
  setPlace(f.name, f.look || c.p);
  if (f.mode) setMode(f.mode, true);
  setCam(c.p, c.alt, c.b, c.t);
  if (mapT) mapT.jumpTo({center: f.look || c.p, zoom: Math.max(mapT.getZoom(), 15.2)});
  if (!PC) $("#panel").classList.add("min");
}
function renderFavs() {
  $("#favCount").textContent = S.favs.length ? `${S.favs.length} か所` : "";
  $("#favList").innerHTML = S.favs.length ? S.favs.map(f => `<div class="it" data-id="${esc(f.id)}">
    <div class="ic">☆</div><div><div class="nm">${esc(f.name)}</div><div class="ds">${f.cam.h != null ? `高さ ${Math.round(f.cam.h)}m` : `標高 ${Math.round(f.cam.alt)}m`}・傾き ${Math.round(f.cam.t)}°</div></div>
    <b class="fb" data-act="ren" title="名前を変える">✎</b><b class="fb" data-act="del" title="消す">✕</b></div>`).join("")
    : `<div class="empty">まだありません。「☆」で今映っている場所を登録できます。</div>`;
}
$("#favList").addEventListener("click", e => {
  const it = e.target.closest(".it"); if (!it) return;
  const f = S.favs.find(x => x.id === it.dataset.id); if (!f) return;
  const act = e.target.closest("[data-act]") && e.target.closest("[data-act]").dataset.act;
  if (act === "ren") { const n = prompt("お気に入りの名前", f.name); if (n !== null && n.trim()) { f.name = n.trim(); save(); renderFavs(); } return; }
  if (act === "del") { if (confirm(`「${f.name}」をお気に入りから消しますか？`)) { S.favs = S.favs.filter(x => x !== f); save(); renderFavs(); } return; }
  goFav(f);
});
for (const id of ["#favAdd", "#favAdd2"]) $(id).addEventListener("click", addFav);
renderFavs();

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
// folder: {name, files} -> on a PC browser that can write folders, also offer to save it as a real folder
async function deliver(blob, name, label, folder) {
  const file = new File([blob], name, {type: blob.type});
  const box = $("#result");
  box.innerHTML = "";
  if (folder && window.showDirectoryPicker) {
    const b = document.createElement("button"); b.className = "pr wide"; b.textContent = `フォルダとして保存（「${folder.name}」を作ります）`;
    b.onclick = () => saveFolder(folder).catch(e => { if (e && e.name !== "AbortError") toast("保存できませんでした: " + (e.message || e), 5000); });
    box.appendChild(b);
  }
  if (navigator.canShare && navigator.canShare({files: [file]})) {
    const b = document.createElement("button"); b.className = "pr wide"; b.textContent = `${label}を共有（pCloud に保存）`;
    b.onclick = () => navigator.share({files: [file], title: name}).catch(() => {});
    box.appendChild(b);
  }
  const a = document.createElement("a"); a.className = "ib wide"; a.textContent = `${label}をダウンロード（${(blob.size / 1048576).toFixed(1)} MB）`;
  a.href = URL.createObjectURL(blob); a.download = name; box.appendChild(a);
  const p = document.createElement("p"); p.className = "note";
  p.textContent = folder
    ? `「${folder.name}」というフォルダの入った zip です（データと範囲のファイルが入っています）。pCloud の受け取りフォルダ（_Rokehan）に保存してください。PC で Claude が Blender で組み立てます。`
    : "pCloud の受け取りフォルダ（_Rokehan）に保存してください。PC で Claude が Blender で組み立てます。";
  box.appendChild(p);
}
// PC: pick a folder (for example pCloud's _Rokehan), and the export is written into a new folder there
async function saveFolder({name, files}) {
  const parent = await window.showDirectoryPicker({id: "rokehan", mode: "readwrite"});
  const root = await parent.getDirectoryHandle(name, {create: true});
  let n = 0;
  for (const f of files) {
    const parts = f.name.split("/"), fname = parts.pop();
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, {create: true});
    const w = await (await dir.getFileHandle(fname, {create: true})).createWritable();
    await w.write(typeof f.data === "string" ? new Blob([f.data], {type: "text/plain"}) : f.data); await w.close();
    n++;
  }
  toast(`「${parent.name}」の中に「${name}」を作りました（${n} ファイル）`, 4000);
}
// The folder name for an export: the rough place name of the middle of the ranges (lib/gsiname.js) and the time
async function exportName() {
  const list = S.shapes.filter(s => s.level !== "none"), b = G.bboxOf(list.flatMap(ringOf));
  let nm = null;
  if (list.length) try { nm = await Promise.race([placeName([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), new Promise(r => setTimeout(() => r(null), 4000))]); } catch {}
  return `${safeName(nm || S.place.name)}_${stamp()}`;
}
function rangesFile() { return {app: "haikei-rokehan", version: 1, saved: new Date().toISOString(), place: S.place, view: S.view, outside: S.outside, outsideR: S.outsideR, shapes: S.shapes, favs: S.favs}; }
async function saveRanges() {
  setTab("export");
  const blob = new Blob([JSON.stringify(rangesFile(), null, 1)], {type: "application/json"});
  await deliver(blob, `${await exportName()}_範囲.json`, "範囲のファイル");
}
function openRanges(text) {
  try {
    let j = JSON.parse(text);
    if (j.format === "haikei-rokehan") j = {shapes: j.ranges.filter(r => r.shape).map(r => r.shape), place: j.place, outside: j.settings.outside, outsideR: j.settings.outsideR};
    if (!Array.isArray(j.shapes)) throw new Error("範囲のファイルではありません");
    S.shapes = j.shapes; S.nextId = Math.max(S.nextId, ...j.shapes.map(s => +String(s.id).replace(/\D/g, "") + 1 || 1));
    if (j.outside) S.outside = j.outside; if (j.outsideR) S.outsideR = j.outsideR;
    if (j.place) setPlace(j.place.name, j.place.c);
    let nf = 0;                                      // favourites in the file are added (the ones already here stay)
    for (const f of Array.isArray(j.favs) ? j.favs : []) if (f && f.cam && !S.favs.some(g => g.id === f.id)) { S.favs.push(f); nf++; }
    if (nf) renderFavs();
    sel = null; save(); renderShapes();
    const all = G.bboxOf(S.shapes.flatMap(ringOf));
    if (S.shapes.length) maps.forEach(m => m.fitBounds([[all[0], all[1]], [all[2], all[3]]], {padding: 50, duration: 600}));
    toast(`範囲を ${S.shapes.length} つ読み込みました`);
  } catch (e) { toast("開けませんでした: " + e.message); }
}
for (const id of ["#saveBtn", "#saveBtnPC"]) $(id).addEventListener("click", saveRanges);
for (const id of ["#openBtn", "#openBtnPC"]) $(id).addEventListener("click", () => $("#openFile").click());
// a range file (.json), or an exported zip: its 範囲.json (or, from older exports, manifest.json)
$("#openFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
    try {
      const ents = await unzip(new Uint8Array(await f.arrayBuffer()));
      const pick = ents.find(x => /(^|\/)範囲\.json$/.test(x.name)) || ents.find(x => /(^|\/)manifest\.json$/.test(x.name));
      if (!pick) throw new Error("範囲の入っていない zip です");
      openRanges(new TextDecoder().decode(pick.data));
    } catch (err) { toast("開けませんでした: " + err.message); }
  } else openRanges(await f.text());
});

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
    const folder = await exportName();
    log(`フォルダの名前: ${folder}`);
    const extraFiles = [{name: "範囲.json", data: JSON.stringify(rangesFile(), null, 1)}];
    const {blob, manifest, files} = await exportData({shapes: S.shapes, place: S.place, omtTiles: src && src.tiles && src.tiles[0], folder, extraFiles,
      settings: {outside: S.outside, outsideR: S.outsideR, terrain: $("#incTerrain").checked},
      onProgress: (msg, f) => { $("#progText").textContent = msg; $("#prog .bar b").style.width = Math.round(f * 100) + "%"; }, log});
    window.__lastExport = {blob, manifest};
    await deliver(blob, `${folder}.zip`, "データ", {name: folder, files: files});
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
    if (k === "r") setTool("rect"); else if (k === "c") setTool("circle"); else if (k === "g") setTool("box"); else if (k === "t") setTool("fan"); else if (k === "v") setTool("select");
    else if (k === "f") { map3.easeTo({center: S.place.c, duration: 600}); }
  }
});

setTool("select");
renderList(); renderSel(); renderEstimate();
window.__app = {S, setMode, walk, runExport, addShape, renderShapes, setCam, getCam, dolly, orbitStart, orbitTo, pan, panView, groundAt, map3, loadNear, loadOsm, get detail() { return detail; }, get sel() { return sel; }};

// ------------------------------------------------------------------ newer version
// GitHub Pages lets a browser keep each file for 10 minutes, and phones keep a page open for days. tools/stamp.py puts
// the same version on every file URL and in version.json; when version.json says a newer one is out, the page reloads
// into it once (at the start, and when you come back to the page after a minute or more away).
const APP_VERSION = "202611200101";
let hiddenAt = 0;
async function checkVersion() {
  if (!APP_VERSION || exporting) return;
  try {
    const v = (await (await fetch("version.json?t=" + Date.now(), {cache: "no-store"})).json()).v;
    if (!v || v === APP_VERSION || sessionStorage.getItem("rokehanReload") === v) return;
    sessionStorage.setItem("rokehanReload", v);
    try { localStorage.setItem("rokehan", JSON.stringify(S)); } catch {}
    toast("新しい版に更新します…");
    setTimeout(() => location.replace(location.pathname + "?v=" + v + location.hash), 600);
  } catch {}
}
checkVersion();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 60000) checkVersion();
});
