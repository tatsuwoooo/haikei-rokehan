// The detailed look near the camera, drawn with three.js inside MapLibre (a "custom layer" that shares its 3D view):
// buildings with windows and pitched roofs, sunlight and shadows, trees, road surfaces with white lines and
// crossings, utility poles with wires, street lamps and traffic signals.
// The scene is built in metres around an origin point: x = east, y = SOUTH (so the map's own axes are not mirrored),
// z = height above sea level.
import * as G from "./geo.js?v=202611200101";

const THREE_URL = "https://unpkg.com/three@0.170.0/build/three.module.min.js";

const WALL = {
  house: {tile: [3.2, 2.9], tints: ["#f2ecdf", "#ebe6de", "#e0d8c8", "#f4f2ee", "#dcd5cb", "#eadfce", "#d8d9d6"]},
  building: {tile: [3.6, 3.4], tints: ["#dcdee1", "#d2d5d9", "#e5e2dc", "#cdc8bf", "#d9d3c8", "#c4cbd4", "#e2ddd3"]},
  tower: {tile: [1.8, 3.6], tints: ["#cdd6e1", "#bfcbd9", "#d6dce4"]},
};
const ROOF = {house: ["#4c4f56", "#5b4b41", "#47535f", "#404247", "#55585e", "#6b3d37"], building: ["#b7babe", "#aeb2b7", "#c2c2bd"],
              tower: ["#9da6b1"], shed: ["#8e949b", "#7d8590", "#9a8f84"]};
const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
const pick = (list, h) => list[Math.floor(h * list.length) % list.length];

export async function createDetail(map, ROAD) {
  const THREE = await import(THREE_URL);
  const isPhone = !matchMedia("(min-width: 900px)").matches;

  // ---------------------------------------------------------------- textures (drawn once)
  function canvasTex(draw, size = 128) {
    const c = document.createElement("canvas"); c.width = c.height = size;
    draw(c.getContext("2d"), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  const glass = (g, x, y, w, h, top, bottom) => { const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, top); gr.addColorStop(1, bottom); g.fillStyle = gr; g.fillRect(x, y, w, h); };
  const tex = {
    building: canvasTex((g, S) => {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, S, S);
      g.fillStyle = "#d9d9d9"; g.fillRect(0, S * 0.84, S, S * 0.16);                       // floor band
      glass(g, S * 0.1, S * 0.2, S * 0.8, S * 0.56, "#7d8ea3", "#3d4856");
      g.fillStyle = "#e9ecef"; g.fillRect(S * 0.495, S * 0.2, S * 0.03, S * 0.56);          // mullion
    }),
    house: canvasTex((g, S) => {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, S, S);
      g.fillStyle = "#f6f6f6"; g.fillRect(S * 0.22, S * 0.26, S * 0.56, S * 0.46);
      glass(g, S * 0.26, S * 0.3, S * 0.48, S * 0.4, "#6c7682", "#40464e");
      g.fillStyle = "#c9c5bd"; g.fillRect(S * 0.2, S * 0.72, S * 0.6, S * 0.04);            // sill
    }),
    tower: canvasTex((g, S) => {
      glass(g, 0, 0, S, S, "#8fa3bb", "#53637a");
      g.fillStyle = "#c3ccd6"; g.fillRect(0, S * 0.9, S, S * 0.1); g.fillRect(0, 0, S * 0.04, S);
    }),
  };

  // ---------------------------------------------------------------- materials
  const lambert = o => new THREE.MeshLambertMaterial(o);
  const mat = {
    wall: Object.fromEntries(Object.keys(WALL).map(k => [k, lambert({map: tex[k], vertexColors: true})])),
    plain: lambert({vertexColors: true}),
    road: lambert({vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8}),
    paint: lambert({color: "#f4f4f0", polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12}),
    yellow: lambert({color: "#e8b53a", polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12}),
    concrete: lambert({color: "#a3a39c"}), metal: lambert({color: "#7f858d"}), dark: lambert({color: "#3a3d42"}),
    trunk: lambert({color: "#6b5440"}), crown: lambert({color: "#ffffff"}),
    lampHead: new THREE.MeshBasicMaterial({color: "#fff6d8"}),
    sigBlue: new THREE.MeshBasicMaterial({color: "#22d6a8"}), sigOff: lambert({color: "#55534d"}),
    wire: new THREE.LineBasicMaterial({color: "#2b2b2b"}),
    ground: lambert({vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4}),
    shadow: new THREE.ShadowMaterial({opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4}),
  };

  // ---------------------------------------------------------------- three.js inside MapLibre
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const sun = new THREE.DirectionalLight("#fff3df", 2.3), hemi = new THREE.HemisphereLight("#e4ecf7", "#8a8577", 1.35);
  hemi.position.set(0, 0, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isPhone ? 1024 : 2048, isPhone ? 1024 : 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target, hemi);
  let root = null, modelM = new THREE.Matrix4(), renderer = null, visible = true, ovl = null, last = null, ovlLines = [];

  const layer = {
    id: "detail3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      renderer = new THREE.WebGLRenderer({canvas: m.getCanvas(), context: gl, antialias: true});
      renderer.autoClear = false;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
    },
    render(gl, args) {
      if (!root || !visible || !renderer) return;
      const m = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : (args && args.modelViewProjectionMatrix) || args;
      camera.projectionMatrix.fromArray(m).multiply(modelM);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.resetState();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.render(scene, camera);
    },
  };

  // ---------------------------------------------------------------- geometry helpers
  class Buf {                                            // non-indexed triangles with normals, uvs and colours
    constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; }
    tri(a, b, c, nrm, col, uva, uvb, uvc) {
      this.p.push(...a, ...b, ...c); this.n.push(...nrm, ...nrm, ...nrm);
      this.uv.push(...(uva || [0, 0]), ...(uvb || [0, 0]), ...(uvc || [0, 0]));
      this.c.push(...col, ...col, ...col);
    }
    quad(a, b, c, d, nrm, col, uv) { this.tri(a, b, c, nrm, col, uv && uv[0], uv && uv[1], uv && uv[2]); this.tri(a, c, d, nrm, col, uv && uv[0], uv && uv[2], uv && uv[3]); }
    mesh(material, shadows = true) {
      if (!this.p.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
      const me = new THREE.Mesh(g, material);
      me.frustumCulled = false; me.castShadow = shadows; me.receiveShadow = true;
      return me;
    }
  }
  const col = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  // Triangles are written so that they face outward; FLIP corrects the winding if the map's view turns out mirrored.
  let FLIP = true;                                     // checked in the browser: MapLibre's view needs the other winding
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function faceTri(buf, a, b, c, nrm, colr, ua, ub, uc) {   // order the corners so the face points along nrm
    const n = cross(sub(b, a), sub(c, a)), same = n[0] * nrm[0] + n[1] * nrm[1] + n[2] * nrm[2] > 0;
    if (same !== FLIP) buf.tri(a, b, c, nrm, colr, ua, ub, uc); else buf.tri(a, c, b, nrm, colr, ua, uc, ub);
  }
  const faceQuad = (buf, a, b, c, d, nrm, colr, uv) => { faceTri(buf, a, b, c, nrm, colr, uv && uv[0], uv && uv[1], uv && uv[2]); faceTri(buf, a, c, d, nrm, colr, uv && uv[0], uv && uv[2], uv && uv[3]); };

  function clear() {
    if (ovl) { ovl.geometry.dispose(); scene.remove(ovl); ovl = null; }
    if (!root) return;
    root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    scene.remove(root); root = null;
  }
  // Lines drawn on top of the ground (range outlines, the mesh grid): the ground here hides the map's own lines.
  // lines: [{pts: [[lon,lat],...], color, width (m), dash (m, 0 = solid)}]
  const ovlMat = new THREE.MeshBasicMaterial({vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16});
  function setOverlay(lines) {
    ovlLines = lines || [];
    if (ovl) { ovl.geometry.dispose(); scene.remove(ovl); ovl = null; }
    if (!root || !last || last.photo) return;           // over the photo, the map's own outlines show
    const O = last.origin, R = last.R + 30, L = p => { const d = G.delta(O, p); return [d[0], -d[1]]; };
    const gz = q => last.ground(G.offset(O, q[0], -q[1]));
    const buf = new Buf();
    for (const ln of ovlLines) {
      const c = col(ln.color), half = ln.width / 2, pts = ln.pts.map(L);
      let s0 = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const nx = -dy / len, ny = dx / len, step = 8;
        for (let t = 0; t < len; t += step) {
          const t1 = Math.min(len, t + step);
          if (ln.dash && ((s0 + t) % (2 * ln.dash)) >= ln.dash) continue;
          const p0 = [a[0] + dx * t / len, a[1] + dy * t / len], p1 = [a[0] + dx * t1 / len, a[1] + dy * t1 / len];
          if (Math.hypot(...p0) > R || Math.hypot(...p1) > R) continue;
          const z0 = gz(p0) + 0.35, z1 = gz(p1) + 0.35;
          faceQuad(buf, [p0[0] - nx * half, p0[1] - ny * half, z0], [p1[0] - nx * half, p1[1] - ny * half, z1],
                        [p1[0] + nx * half, p1[1] + ny * half, z1], [p0[0] + nx * half, p0[1] + ny * half, z0], [0, 0, 1], c);
        }
        s0 += len;
      }
    }
    ovl = buf.mesh(ovlMat, false);
    if (ovl) { ovl.castShadow = false; ovl.receiveShadow = false; scene.add(ovl); }
    map.triggerRepaint();
  }

  // ---------------------------------------------------------------- build everything around `origin`
  // data: {origin, R, ground(lonlat)->m, buildings:[{rings, kind, h, base}], roads:[{cls, pts, brunnel}], props, trees:[lonlat]}
  function build(data) {
    clear();
    last = data;
    const O = data.origin, ground = data.ground;
    const L = p => { const d = G.delta(O, p); return [d[0], -d[1]]; };          // lon/lat -> local x (east), y (south)
    const LL = q => G.offset(O, q[0], -q[1]);
    const gz = q => ground(LL(q));
    root = new THREE.Group();
    const merc = maplibregl.MercatorCoordinate.fromLngLat({lng: O[0], lat: O[1]}, 0), s = merc.meterInMercatorCoordinateUnits();
    modelM = new THREE.Matrix4().makeTranslation(merc.x, merc.y, 0).scale(new THREE.Vector3(s, s, s));
    const g0 = ground(O);

    // ---- buildings
    const walls = {house: new Buf(), building: new Buf(), tower: new Buf()}, roofs = new Buf();
    for (const b of data.buildings) {
      const rings = b.rings.map(r => { const q = r.map(L); if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop(); return q; })
        .filter(r => r.length >= 3);
      if (!rings.length) continue;
      const outer = rings[0], cen = G.ringCentroid(outer), hh = hash(Math.round(cen[0] + O[0] * 1e5), Math.round(cen[1] + O[1] * 1e5));
      const kind = b.kind || "building";
      const zg = gz(cen), zlow = Math.min(zg, ...outer.filter((_, i) => i % Math.ceil(outer.length / 6) === 0).map(gz)) - 1;
      const top = zg + b.h, bottom = b.base > 0.5 ? zg + b.base : zlow;
      const area = G.ringArea(outer);
      if (kind === "shed") {                       // roof only, on thin posts (the posts are left out)
        const rc = col(pick(ROOF.shed, hh)), zt = zg + Math.min(b.h, 2.7);
        roofTop(roofs, rings, zt, rc); roofTop(roofs, rings, zt - 0.15, rc, true);
        continue;
      }
      const W = WALL[kind], tint = col(pick(W.tints, hh)), rcol = col(pick(kind === "house" && area > 250 ? ROOF.building : ROOF[kind], hash(hh, 3.7)));
      // pitched roof for small, roughly rectangular houses
      let eave = top, gable = null;
      if (kind === "house") {
        const ob = G.orientedBox(outer);
        if (ob[2] * ob[3] > 0 && area / (ob[2] * ob[3]) > 0.8 && Math.max(ob[2], ob[3]) < 26 && Math.min(ob[2], ob[3]) > 3) {
          const short = Math.min(ob[2], ob[3]), rise = short / 2 * Math.tan((22 + hh * 10) * Math.PI / 180);
          eave = Math.max(zg + 2.6, top - rise); gable = {ob, rise: top - eave};
        }
      }
      for (const [ri, r] of rings.entries()) {
        const flip = (signedArea(r) > 0) === (ri > 0);       // outward: right of each edge for a CCW outer ring, left for holes
        let u = 0;
        for (let i = 0; i < r.length; i++) {
          const a = r[i], c = r[(i + 1) % r.length], dx = c[0] - a[0], dy = c[1] - a[1], len = Math.hypot(dx, dy);
          if (len < 0.05) continue;
          let nx = dy / len, ny = -dx / len;
          if (flip) { nx = -nx; ny = -ny; }
          const nrm = [nx, ny, 0], u0 = u / W.tile[0], u1 = (u + len) / W.tile[0];
          const v0 = (bottom - zg) / W.tile[1], v1 = (eave - zg) / W.tile[1];
          faceQuad(walls[kind], [a[0], a[1], bottom], [c[0], c[1], bottom], [c[0], c[1], eave], [a[0], a[1], eave], nrm, tint,
            [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
          u += len;
        }
      }
      if (gable) pitched(roofs, gable.ob, eave, gable.rise, rcol, tint);
      else roofTop(roofs, rings, eave, rcol);
    }
    function signedArea(r) { let s2 = 0; for (let i = 0; i < r.length; i++) { const a = r[i], c = r[(i + 1) % r.length]; s2 += a[0] * c[1] - c[0] * a[1]; } return s2 / 2; }
    function roofTop(buf, rings, z, c, down) {
      const contour = rings[0].map(p => new THREE.Vector2(p[0], p[1])), holes = rings.slice(1).map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
      const pts = rings.flat(), tris = THREE.ShapeUtils.triangulateShape(contour, holes);
      for (const [i, j, k] of tris) faceTri(buf, [pts[i][0], pts[i][1], z], [pts[j][0], pts[j][1], z], [pts[k][0], pts[k][1], z], [0, 0, down ? -1 : 1], c);
    }
    function pitched(buf, ob, eave, rise, rc, wallC) {
      const [cx, cy, w, d, angDeg] = ob, a = angDeg * Math.PI / 180;
      // long axis = ridge direction
      const along = w >= d ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)], across = [-along[1], along[0]];
      const hl = Math.max(w, d) / 2 + 0.35, hs = Math.min(w, d) / 2 + 0.45, ze = eave - 0.25, zr = eave + rise;
      const P = (u, v, z) => [cx + along[0] * u + across[0] * v, cy + along[1] * u + across[1] * v, z];
      const r1 = P(-hl, 0, zr), r2 = P(hl, 0, zr);
      for (const sgn of [1, -1]) {
        const e1 = P(-hl, sgn * hs, ze), e2 = P(hl, sgn * hs, ze);
        const n = cross(sub(e2, e1), sub(r1, e1)), nl = Math.hypot(...n) || 1;
        let nrm = n.map(v => v / nl); if (nrm[2] < 0) nrm = nrm.map(v => -v);
        faceQuad(buf, e1, e2, r2, r1, nrm, rc);
        faceQuad(buf, P(-hl, sgn * hs, ze - 0.12), P(hl, sgn * hs, ze - 0.12), e2, e1, [across[0] * sgn, across[1] * sgn, 0], rc);   // eave edge
      }
      // gable ends (wall colour), from the wall top to the ridge
      const hw = Math.min(w, d) / 2;
      for (const sgn of [1, -1]) {
        const u = sgn * (Math.max(w, d) / 2);
        faceTri(buf, P(u, -hw, eave), P(u, hw, eave), P(u, 0, zr - 0.05), [along[0] * sgn, along[1] * sgn, 0], wallC);
      }
    }
    for (const k of Object.keys(walls)) { const me = walls[k].mesh(mat.wall[k]); if (me) root.add(me); }
    { const me = roofs.mesh(mat.plain); if (me) root.add(me); }

    // ---- roads and ground: only over the plain map. Over the aerial photo, the photo shows the real roads and ground.
    if (!data.photo) {
    // ---- roads: sidewalk band, carriageway, white lines
    const road = new Buf(), paint = new Buf(), yellow = new Buf();
    const asphalt = col("#6f7276"), walkC = col("#bdb8ae"), trackC = col("#9b907c"), pathC = col("#c2b9a8");
    const junc = (data.props.junctions || []).map(j => ({q: L(j.p), hw: j.hw}));
    const inJunction = q => junc.some(j => Math.hypot(j.q[0] - q[0], j.q[1] - q[1]) < j.hw + 1.2);
    const ribbon = (buf, pts, half, lift, c, off = 0) => {      // a band following the ground, offset sideways by off
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        const nx = -dy / len, ny = dx / len, steps = Math.max(1, Math.ceil(len / 12));
        for (let k = 0; k < steps; k++) {
          const t0 = k / steps, t1 = (k + 1) / steps;
          const p0 = [a[0] + dx * t0 + nx * off, a[1] + dy * t0 + ny * off], p1 = [a[0] + dx * t1 + nx * off, a[1] + dy * t1 + ny * off];
          const z0 = gz(p0) + lift, z1 = gz(p1) + lift;
          faceQuad(buf, [p0[0] - nx * half, p0[1] - ny * half, z0], [p1[0] - nx * half, p1[1] - ny * half, z1],
                        [p1[0] + nx * half, p1[1] + ny * half, z1], [p0[0] + nx * half, p0[1] + ny * half, z0], [0, 0, 1], c);
        }
      }
    };
    const disc = (buf, q, r, lift, c) => {
      const z = gz(q) + lift, n = 10;
      for (let i = 0; i < n; i++) {
        const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
        faceTri(buf, [q[0], q[1], z], [q[0] + r * Math.cos(a0), q[1] + r * Math.sin(a0), z], [q[0] + r * Math.cos(a1), q[1] + r * Math.sin(a1), z], [0, 0, 1], c);
      }
    };
    const dashes = (buf, pts, off, half, lift, on, gap) => {   // dashed (gap > 0) or solid line, skipping junctions
      let s0 = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        const nx = -dy / len, ny = dx / len, step = Math.min(on, 6);
        for (let t = 0; t < len; t += step) {
          const t1 = Math.min(len, t + step), mid = s0 + (t + t1) / 2;
          if (gap > 0 && (mid % (on + gap)) > on) continue;
          const p0 = [a[0] + dx * t / len + nx * off, a[1] + dy * t / len + ny * off], p1 = [a[0] + dx * t1 / len + nx * off, a[1] + dy * t1 / len + ny * off];
          if (inJunction(p0) || inJunction(p1)) continue;
          const z0 = gz(p0) + lift, z1 = gz(p1) + lift;
          faceQuad(buf, [p0[0] - nx * half, p0[1] - ny * half, z0], [p1[0] - nx * half, p1[1] - ny * half, z1],
                        [p1[0] + nx * half, p1[1] + ny * half, z1], [p0[0] + nx * half, p0[1] + ny * half, z0], [0, 0, 1], [1, 1, 1]);
        }
        s0 += len;
      }
    };
    const rs = data.roads.filter(r => ROAD[r.cls] && r.brunnel !== "bridge" && r.brunnel !== "tunnel" && r.cls !== "motorway");
    for (const r of rs) {                 // sidewalks first (lowest), then the road surface
      const R = ROAD[r.cls], pts = r.pts.map(L);
      if (R.walk) { ribbon(road, pts, R.w / 2 + R.walk, 0.1, walkC); pts.forEach(q => disc(road, q, R.w / 2 + R.walk, 0.1, walkC)); }
    }
    for (const r of rs) {
      const R = ROAD[r.cls], pts = r.pts.map(L), c = r.cls === "path" ? pathC : r.cls === "track" ? trackC : asphalt;
      const lift = R.rank >= 0.5 ? 0.16 : 0.13;
      ribbon(road, pts, R.w / 2, lift, c); pts.forEach(q => disc(road, q, R.w / 2, lift, c));
      if (R.rank >= 1) for (const sgn of [1, -1]) dashes(paint, pts, sgn * (R.w / 2 - 0.4), 0.075, 0.2, 6, 0);       // edge lines
      if (R.rank >= 3) dashes(paint, pts, 0, 0.08, 0.2, 6, 0);                                                    // centre: solid
      else if (R.rank >= 2) dashes(paint, pts, 0, 0.07, 0.2, 5, 5);                                               // centre: dashed
    }
    const rails = new Buf(), ballast = col("#9a948a"), steel = col("#5b5650");
    for (const r of data.roads) {
      if ((r.cls !== "rail" && r.cls !== "transit") || r.brunnel === "bridge" || r.brunnel === "tunnel" || r.sub === "subway") continue;
      const pts = r.pts.map(L);
      ribbon(rails, pts, 1.6, 0.12, ballast);
      for (const off of [-0.72, 0.72]) ribbon(rails, pts, 0.05, 0.3, steel, off);
    }
    { const me = rails.mesh(mat.road, false); if (me) root.add(me); }
    // crossings: white bars across the road
    for (const cr of data.props.crossings) {
      const q = L(cr.p), a = -cr.a * Math.PI / 180, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]];   // y is south: flip the angle
      const n = Math.max(2, Math.floor(cr.w / 0.9));
      for (let i = 0; i < n; i++) {
        const off = -cr.w / 2 + 0.45 + i * (cr.w - 0.45) / Math.max(1, n - 1) - 0.225;
        const c0 = [q[0] + v[0] * off, q[1] + v[1] * off], hl = cr.d / 2;
        const z = gz(c0) + 0.21;
        const P = (du, dv) => [c0[0] + u[0] * du + v[0] * dv, c0[1] + u[1] * du + v[1] * dv, z];
        faceQuad(paint, P(-hl, 0), P(hl, 0), P(hl, 0.45), P(-hl, 0.45), [0, 0, 1], [1, 1, 1]);
      }
    }
    for (const [b, m] of [[road, mat.road], [paint, mat.paint], [yellow, mat.yellow]]) { const me = b.mesh(m, false); if (me) root.add(me); }

    // ---- the ground: grey, with parks, woods and water coloured (a grid that follows the terrain, takes the shadows)
    {
      const R = data.R + 30, step = isPhone ? 10 : 6, n = Math.ceil(2 * R / step), buf = new Buf();
      const areas = (data.green || []).map(g => { const rings = g.rings.map(r => r.map(L)); return {kind: g.kind, rings, bb: G.bboxOf(rings[0])}; })
        .filter(a => a.bb[2] > -R && a.bb[0] < R && a.bb[3] > -R && a.bb[1] < R);
      const order = {water: 3, wood: 2, park: 1};
      areas.sort((a, b) => order[b.kind] - order[a.kind]);
      const GC = {ground: col("#d8d5ce"), park: col("#b6c99c"), wood: col("#97b07f"), water: col("#9fbfd6")};
      const kindAt = q => { for (const a of areas) if (q[0] >= a.bb[0] && q[0] <= a.bb[2] && q[1] >= a.bb[1] && q[1] <= a.bb[3] &&
        G.pointInRing(q, a.rings[0]) && !a.rings.slice(1).some(h => G.pointInRing(q, h))) return a.kind; return "ground"; };
      const zs = [];
      for (let j = 0; j <= n; j++) { zs.push([]); for (let i = 0; i <= n; i++) zs[j].push(gz([-R + i * step, -R + j * step]) + 0.04); }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x0 = -R + i * step, y0 = -R + j * step, x1 = x0 + step, y1 = y0 + step;
        if (Math.hypot(x0 + step / 2, y0 + step / 2) > R) continue;
        faceQuad(buf, [x0, y0, zs[j][i]], [x1, y0, zs[j][i + 1]], [x1, y1, zs[j + 1][i + 1]], [x0, y1, zs[j + 1][i]], [0, 0, 1],
          GC[kindAt([x0 + step / 2, y0 + step / 2])]);
      }
      const me = buf.mesh(mat.ground, false); if (me) { me.castShadow = false; root.add(me); }
    }
    }

    // ---- instanced things: trees, poles, lamps, signals
    const inst = (geo, material, list, place, shadow = true) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, material, list.length), m4 = new THREE.Matrix4();
      list.forEach((it, i) => { place(it, m4, i); im.setMatrixAt(i, m4); });
      im.frustumCulled = false; im.castShadow = shadow; im.receiveShadow = true;
      root.add(im); return im;
    };
    const up = geo => geo.rotateX(Math.PI / 2);                  // three.js shapes stand on y; ours stand on z
    const qz = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1), V = (x, y, z) => new THREE.Vector3(x, y, z);
    const at = (m4, x, y, z, ang, sx = 1, sy = 1, sz = 1) => m4.compose(V(x, y, z), qz.setFromAxisAngle(Z, ang), V(sx, sy, sz));
    const yaw = aDeg => -aDeg * Math.PI / 180;                  // map angle (east = 0, CCW, north up) -> local (y south)

    // trees
    // trees: [lon, lat] or {p, r (crown radius m, from the photo)}
    const trees = data.trees.map(t => {
      const p = t.p || t, q = L(p), h = hash(p[0] * 3.1e4, p[1] * 1.7e4);
      const r = t.r ? t.r * (0.9 + 0.2 * h) : 1.7 + h * 1.6, ht = t.r ? 1.6 + r * 1.5 + h * 1.5 : 3.2 + h * 3.5;
      return {q, z: gz(q), h, k: hash(p[1] * 2.3e4, p[0] * 1.1e4), r, ht};
    });
    const crownG = new THREE.IcosahedronGeometry(1, 1), trunkG = up(new THREE.CylinderGeometry(0.14, 0.2, 1, 6)).translate(0, 0, 0.5);
    inst(trunkG, mat.trunk, trees, (t, m4) => at(m4, t.q[0], t.q[1], t.z - 0.2, 0, 1, 1, Math.max(1.5, t.ht - t.r * 0.6)));
    const crowns = inst(crownG, mat.crown, trees, (t, m4) => {
      at(m4, t.q[0], t.q[1], t.z + t.ht, t.k * 6, t.r, t.r * (0.85 + t.k * 0.3), t.r * 1.05);
    });
    if (crowns) { const greens = ["#5f8c4c", "#4f7d43", "#6b9654", "#577f45", "#7a9a57", "#4a7340"].map(h => new THREE.Color(h));
      trees.forEach((t, i) => crowns.setColorAt(i, greens[Math.floor(t.k * greens.length) % greens.length])); }

    // utility poles, cross-arms, transformers, wires
    const P = data.props, poles = P.poles.map(p => ({q: L(p.p), a: yaw(p.a), z: gz(L(p.p))}));
    inst(up(new THREE.CylinderGeometry(0.13, 0.17, 1, 8)).translate(0, 0, 0.5), mat.concrete, poles, (p, m4) => at(m4, p.q[0], p.q[1], p.z - 0.3, 0, 1, 1, 11.3));
    inst(new THREE.BoxGeometry(0.12, 1.7, 0.12), mat.metal, poles, (p, m4) => at(m4, p.q[0], p.q[1], p.z + 10.4, p.a));
    const trans = poles.filter((p, i) => hash(p.q[0], p.q[1]) < 0.3);
    inst(up(new THREE.CylinderGeometry(0.3, 0.3, 1.1, 10)), mat.metal, trans, (p, m4) => at(m4, p.q[0] + 0.45 * Math.sin(p.a), p.q[1] - 0.45 * Math.cos(p.a), p.z + 8.2, 0));
    {
      const segs = [];
      for (const [pa, pb] of P.wires) {
        const a = L(pa), b = L(pb), za = gz(a), zb = gz(b), dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        for (const [off, hgt, sag] of [[-0.7, 10.45, 0.5], [0, 10.45, 0.5], [0.7, 10.45, 0.5], [0.2, 7.4, 0.35]]) {
          let prev = null;
          for (let k = 0; k <= 6; k++) {
            const t = k / 6, x = a[0] + dx * t + nx * off, y = a[1] + dy * t + ny * off, z = za + (zb - za) * t + hgt - sag * 4 * t * (1 - t);
            if (prev) segs.push(...prev, x, y, z);
            prev = [x, y, z];
          }
        }
      }
      if (segs.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
        const ls = new THREE.LineSegments(g, mat.wire); ls.frustumCulled = false; root.add(ls); }
    }

    // street lamps: pole, arm over the road, lamp head
    const lamps = P.lamps.map(p => ({q: L(p.p), a: yaw(p.a), z: gz(L(p.p))}));
    inst(up(new THREE.CylinderGeometry(0.07, 0.1, 1, 6)).translate(0, 0, 0.5), mat.metal, lamps, (p, m4) => at(m4, p.q[0], p.q[1], p.z, 0, 1, 1, 7.6));
    inst(new THREE.BoxGeometry(1.6, 0.08, 0.08).translate(0.8, 0, 0), mat.metal, lamps, (p, m4) => at(m4, p.q[0], p.q[1], p.z + 7.55, p.a));
    inst(new THREE.BoxGeometry(0.6, 0.26, 0.14), mat.lampHead, lamps, (p, m4) => at(m4, p.q[0] + 1.5 * Math.cos(p.a), p.q[1] + 1.5 * Math.sin(p.a), p.z + 7.45, p.a), false);

    // traffic signals: pole, arm, box with lights (the "blue" one lit)
    const sigs = P.signals.map(s => ({q: L(s.p), a: yaw(s.a), z: gz(L(s.p)), arm: s.arm}));
    inst(up(new THREE.CylinderGeometry(0.11, 0.13, 1, 8)).translate(0, 0, 0.5), mat.metal, sigs, (s, m4) => at(m4, s.q[0], s.q[1], s.z, 0, 1, 1, 6));
    const armDir = s => s.a - Math.PI / 2;                       // to the left of the way the lights face (y is south)
    inst(new THREE.BoxGeometry(1, 0.1, 0.1).translate(0.5, 0, 0), mat.metal, sigs, (s, m4) => at(m4, s.q[0], s.q[1], s.z + 5.7, armDir(s), s.arm, 1, 1));
    const headPos = s => [s.q[0] + Math.cos(armDir(s)) * s.arm, s.q[1] + Math.sin(armDir(s)) * s.arm];
    inst(new THREE.BoxGeometry(0.42, 1.3, 0.42), mat.dark, sigs, (s, m4) => { const h = headPos(s); at(m4, h[0], h[1], s.z + 5.55, s.a); });
    const lightAt = (s, k) => { const h = headPos(s), f = 0.23, along = (k - 1) * 0.4;
      return [h[0] + Math.cos(s.a) * f + Math.cos(armDir(s)) * along, h[1] + Math.sin(s.a) * f + Math.sin(armDir(s)) * along]; };
    inst(new THREE.BoxGeometry(0.06, 0.3, 0.3), mat.sigBlue, sigs, (s, m4) => { const p = lightAt(s, 0); at(m4, p[0], p[1], s.z + 5.55, s.a); }, false);
    inst(new THREE.BoxGeometry(0.06, 0.3, 0.3), mat.sigOff, sigs.concat(sigs), (s, m4, i) => { const p = lightAt(s, i < sigs.length ? 1 : 2); at(m4, p[0], p[1], s.z + 5.55, s.a); }, false);

    // ---- sun and shadow box around the origin
    const R = data.R + 60, dir = V(-0.55, 0.62, 0.85).normalize();      // sun from the south-west, fairly high
    sun.position.set(dir.x * 900, dir.y * 900, g0 + dir.z * 900); sun.target.position.set(0, 0, g0);
    const sc = sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 10; sc.far = 2500; sc.updateProjectionMatrix();
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    scene.add(root);
    if (renderer) renderer.shadowMap.needsUpdate = true;
    setOverlay(ovlLines);
    map.triggerRepaint();
    return {buildings: data.buildings.length, trees: trees.length, poles: poles.length, lamps: lamps.length, signals: sigs.length, crossings: data.props.crossings.length};
  }

  return {
    layer, build, setOverlay, clear: () => { clear(); last = null; map.triggerRepaint(); },
    setVisible(v) { visible = v; map.triggerRepaint(); },
    setFlip(v) { FLIP = v; },
    get root() { return root; }, THREE,
  };
}
