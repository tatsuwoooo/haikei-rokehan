"""Build a white model in Blender from a 背景ロケハン export (see notes/format.md).

    blender -b --factory-startup --python rokehan_build.py -- <export .zip or its folder>

For "<inbox>/<name>.zip" it makes, next to the zip:
    <name>/data/                  the zip unpacked (manifest.json, 範囲.json, sections/, terrain/)
    <name>/区画/<section id>.blend  one .blend per section: terrain, roads, buildings (one object each),
                                  trees / poles / lamps / signals (one object each, shared meshes), ...
    <name>/<place>.blend           the parent: links every section's collection, plus a sun, a camera and the 中心点
                                  (an empty where the far boards are shot from, and a camera at its eye height)

White model only (the step that checks the layout): plain grey materials, no library assets yet.
Every object has its origin at the bottom centre of its bounds (the blender-object-seiri rule), and the
collections are "section -> kind" (everything is "sub" for now). Far sections: all the building boxes of a
section are one mesh (thousands of boxes that never move; recorded as an exception).
"""
import bpy, bmesh, json, math, os, re, struct, sys, zipfile, zlib
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = os.path.abspath(ARGS[0])

# ------------------------------------------------------------------ unpack
if SRC.lower().endswith(".zip"):
    NAME = os.path.splitext(os.path.basename(SRC))[0]
    ROOT = os.path.join(os.path.dirname(SRC), NAME)
    DATA = os.path.join(ROOT, "data")
    if not os.path.exists(os.path.join(DATA, "manifest.json")):
        with zipfile.ZipFile(SRC) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                parts = info.filename.split("/")
                rel = "/".join(parts[1:]) if len(parts) > 1 and parts[0] == NAME else info.filename
                out = os.path.join(DATA, *rel.split("/"))
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "wb") as fh:
                    fh.write(z.read(info))
else:
    ROOT = SRC.rstrip("\\/")
    NAME = os.path.basename(ROOT)
    DATA = os.path.join(ROOT, "data") if os.path.exists(os.path.join(ROOT, "data", "manifest.json")) else ROOT
PLACE = re.sub(r"_\d{8}-\d{4}$", "", NAME) or NAME          # "三軒茶屋駅前_20261120-0059" -> "三軒茶屋駅前"
M = json.load(open(os.path.join(DATA, "manifest.json"), encoding="utf-8"))
print("[rokehan] build", NAME, "->", ROOT)

# ------------------------------------------------------------------ plane rectangular coordinates (same as docs/lib/geo.js)
ZONES = {1: (33, 129.5), 2: (33, 131), 3: (36, 132 + 10 / 60), 4: (33, 133.5), 5: (36, 134 + 20 / 60), 6: (36, 136),
         7: (36, 137 + 10 / 60), 8: (36, 138.5), 9: (36, 139 + 50 / 60), 10: (40, 140 + 50 / 60), 11: (44, 140.25),
         12: (44, 142.25), 13: (44, 144.25), 14: (26, 142), 15: (26, 127.5), 16: (26, 124), 17: (26, 131), 18: (20, 136), 19: (26, 154)}
_a, _F, _m0 = 6378137.0, 298.257222101, 0.9999
_n = 1 / (2 * _F - 1); _e = 2 * math.sqrt(_n) / (1 + _n)
_A = _m0 * _a / (1 + _n) * (1 + _n ** 2 / 4 + _n ** 4 / 64)
_AL = [_n / 2 - 2 * _n ** 2 / 3 + 5 * _n ** 3 / 16 + 41 * _n ** 4 / 180 - 127 * _n ** 5 / 288,
       13 * _n ** 2 / 48 - 3 * _n ** 3 / 5 + 557 * _n ** 4 / 1440 + 281 * _n ** 5 / 630,
       61 * _n ** 3 / 240 - 103 * _n ** 4 / 140 + 15061 * _n ** 5 / 26880,
       49561 * _n ** 4 / 161280 - 179 * _n ** 5 / 168, 34729 * _n ** 5 / 80640]


def _tm(lat, lon, lon0):
    p, dl = math.radians(lat), math.radians(lon - lon0)
    t = math.sinh(math.atanh(math.sin(p)) - _e * math.atanh(_e * math.sin(p)))
    tb = math.sqrt(1 + t * t)
    xi, eta = math.atan2(t, math.cos(dl)), math.atanh(math.sin(dl) / tb)
    x, y = xi, eta
    for j in range(1, 6):
        x += _AL[j - 1] * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        y += _AL[j - 1] * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    return _A * x, _A * y


_lat0, _lon0 = ZONES[M["zone"]]
_x0 = _tm(_lat0, _lon0, _lon0)[0]
OX, OY = M["origin"]["plane"]


def local(lon, lat):
    x, y = _tm(lat, lon, _lon0)
    return y - OX, x - _x0 - OY


# ------------------------------------------------------------------ terrain (GSI elevation PNG tiles)
def read_png_rgb(path):
    """Minimal PNG reader (8-bit RGB / RGBA, no interlace) -> (w, h, rows of bytes per pixel 3/4)."""
    b = open(path, "rb").read()
    pos, w = 8, 0
    idat = b""
    while pos < len(b):
        ln, typ = struct.unpack(">I4s", b[pos:pos + 8])
        chunk = b[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
            bpp = {2: 3, 6: 4}[ctype]
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            up = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + up) & 255
            elif f == 3: line[x] = (line[x] + ((a + up) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(up - c), abs(a - c), abs(a + up - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        rows.append(bytes(line)); prev = line
    return w, h, bpp, rows


TILES = {}      # (z, x, y) -> list of heights (None = no data), 256 x 256
for t in M["terrain"]["tiles"]:
    path = os.path.join(DATA, *t["file"].split("/"))
    if not os.path.exists(path):
        continue
    w, h, bpp, rows = read_png_rgb(path)
    hs = []
    for r in rows:
        for x in range(w):
            R, G, B = r[x * bpp], r[x * bpp + 1], r[x * bpp + 2]
            if (R, G, B) == (128, 0, 0):
                hs.append(None); continue
            v = (R << 16) | (G << 8) | B
            if v >= 1 << 23: v -= 1 << 24
            hs.append(v * 0.01)
    TILES[(t["z"], t["x"], t["y"])] = hs
ZOOMS = sorted({k[0] for k in TILES}, reverse=True)
print("[rokehan] terrain tiles", len(TILES), "zooms", ZOOMS)


def elev(lon, lat):
    for z in ZOOMS:
        k = 2 ** z
        fx = (lon + 180) / 360 * k * 256 - 0.5
        fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * k * 256 - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        vals = []
        for dy in (0, 1):
            for dx in (0, 1):
                px, py = x0 + dx, y0 + dy
                hs = TILES.get((z, px // 256, py // 256))
                vals.append(hs[(py % 256) * 256 + (px % 256)] if hs else None)
        if None in vals:
            ok = [v for v in vals if v is not None]
            if ok:
                return sum(ok) / len(ok)
            continue
        tx, ty = fx - x0, fy - y0
        return (vals[0] * (1 - tx) + vals[1] * tx) * (1 - ty) + (vals[2] * (1 - tx) + vals[3] * tx) * ty
    return 0.0


# local -> lon/lat for sampling: invert local() by a few Newton steps from the equirectangular guess
LON_C, LAT_C = M["center"]
KLAT = 111132.92 - 559.82 * math.cos(2 * math.radians(LAT_C))
KLON = 111412.84 * math.cos(math.radians(LAT_C))
CX, CY = local(LON_C, LAT_C)


def lonlat(x, y):
    lon, lat = LON_C + (x - CX) / KLON, LAT_C + (y - CY) / KLAT
    for _ in range(3):
        ex, ey = local(lon, lat)
        lon += (x - ex) / KLON; lat += (y - ey) / KLAT
    return lon, lat


def ground(x, y):
    return elev(*lonlat(x, y))


# ------------------------------------------------------------------ helpers
def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1)
        bsdf.inputs["Roughness"].default_value = 0.8
    return m


MATS = {}
def M_(key):
    pal = {"地形": (0.42, 0.45, 0.38), "道": (0.22, 0.22, 0.23), "歩道": (0.45, 0.44, 0.42), "建物": (0.82, 0.82, 0.80),
           "高い建物": (0.70, 0.73, 0.78), "屋根だけ": (0.55, 0.55, 0.55), "木": (0.25, 0.42, 0.22), "幹": (0.30, 0.22, 0.15),
           "柱": (0.50, 0.50, 0.50), "電線": (0.05, 0.05, 0.05), "白線": (0.9, 0.9, 0.9), "信号": (0.2, 0.2, 0.2),
           "小物": (0.6, 0.35, 0.25), "柵": (0.6, 0.6, 0.6), "遠景": (0.75, 0.75, 0.75)}
    if key not in MATS:
        MATS[key] = mat(key, pal[key])
    return MATS[key]


def coll(name, parent):
    c = bpy.data.collections.new(name)
    parent.children.link(c)
    return c


def obj_from(name, verts, faces, c, material, origin=None):
    """Mesh object whose origin is at the bottom centre of its bounds (or the given origin)."""
    if not verts:
        return None
    if origin is None:
        xs, ys, zs = [v[0] for v in verts], [v[1] for v in verts], [v[2] for v in verts]
        origin = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs))
    me = bpy.data.meshes.new(name)
    me.from_pydata([(v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]) for v in verts], [], faces)
    me.validate(); me.update()
    if material:
        me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    o.location = origin
    c.objects.link(o)
    return o


def serial(prefix, n, total):
    return f"{prefix}_{n:0{max(2, len(str(total)))}d}"


def ribbon(pts, width, zfn, lift=0.05, step=5.0):
    """Quad strip along a polyline, draped on the ground. -> verts, faces"""
    dense = []
    for i in range(1, len(pts)):
        (x0, y0), (x1, y1) = pts[i - 1], pts[i]
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L / step))
        for k in range(n):
            dense.append((x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))
    dense.append(tuple(pts[-1]))
    verts, faces = [], []
    hw = width / 2
    for i, (x, y) in enumerate(dense):
        a = dense[max(0, i - 1)]; b = dense[min(len(dense) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L * hw, dx / L * hw
        verts += [(x + nx, y + ny, zfn(x + nx, y + ny) + lift), (x - nx, y - ny, zfn(x - nx, y - ny) + lift)]
        if i:
            j = len(verts) - 4
            faces.append((j, j + 1, j + 3, j + 2))
    return verts, faces


ROAD_W = {"motorway": 14, "trunk": 13, "primary": 11, "secondary": 8.5, "tertiary": 7, "unclassified": 4.5, "residential": 4.5,
          "living_street": 4, "road": 4.5, "service": 3.5, "track": 3, "busway": 7}
PATH_W = {"footway": 1.6, "path": 1.6, "pedestrian": 4, "cycleway": 2, "steps": 1.6, "bridleway": 1.6, "corridor": 1.6}


def road_width(kind, tags):
    base = str(kind or "").replace("_link", "")
    try:
        w = float(str(tags.get("width", "")).replace("m", "").strip())
        if 1 < w < 40:
            return w, base in ROAD_W
    except ValueError:
        pass
    if base in ROAD_W: return ROAD_W[base], True
    if base in PATH_W: return PATH_W[base], False
    return 3.0, False


def prism(ring, z0, z1):
    """Closed prism over a polygon (ring without the closing point). -> verts, faces"""
    n = len(ring)
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return verts, faces


def ring_area(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2


# shared meshes for the point things (origin at the foot, 1 = the default size)
def shared_meshes():
    def cyl(name, r, h, seg=8, z0=0.0, m=None):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=h)
        bmesh.ops.translate(bm, vec=(0, 0, z0 + h / 2), verts=bm.verts)
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
        if m: me.materials.append(m)
        return me

    def join(name, parts):
        bm = bmesh.new()
        for me in parts:
            bm.from_mesh(me)
        out = bpy.data.meshes.new(name)
        for me in parts:
            for m in me.materials:
                if m.name not in [x.name for x in out.materials]:
                    out.materials.append(m)
        bm.to_mesh(out); bm.free()
        # face material index from the part order
        idx, f = [], 0
        for k, me in enumerate(parts):
            mi = [x.name for x in out.materials].index(me.materials[0].name)
            idx += [mi] * len(me.polygons)
        for p, i in zip(out.polygons, idx):
            p.material_index = i
        for me in parts:
            bpy.data.meshes.remove(me)
        return out

    trunk = cyl("_trunk", 0.15, 2.4, 6, 0, M_("幹"))
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    bmesh.ops.scale(bm, vec=(1, 1, 1.15), verts=bm.verts); bmesh.ops.translate(bm, vec=(0, 0, 3.4), verts=bm.verts)
    crown = bpy.data.meshes.new("_crown"); bm.to_mesh(crown); bm.free(); crown.materials.append(M_("木"))
    tree = join("木", [trunk, crown])
    pole = cyl("電柱", 0.16, 10.0, 8, 0, M_("柱"))
    lamp = cyl("街灯", 0.08, 6.0, 8, 0, M_("柱"))
    sig_p = cyl("_sigpole", 0.1, 5.0, 8, 0, M_("柱"))
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(0.4, 1.2, 0.45), verts=bm.verts); bmesh.ops.translate(bm, vec=(0, 0, 5.0), verts=bm.verts)
    head = bpy.data.meshes.new("_sighead"); bm.to_mesh(head); bm.free(); head.materials.append(M_("信号"))
    signal = join("信号", [sig_p, head])
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.translate(bm, vec=(0, 0, 0.5), verts=bm.verts)
    box = bpy.data.meshes.new("小物"); bm.to_mesh(box); bm.free(); box.materials.append(M_("小物"))
    return {"tree": tree, "pole": pole, "lamp": lamp, "signal": signal, "box": box}


SMALL = {"vending_machine": ("自販機", (0.9, 0.7, 1.8)), "bench": ("ベンチ", (1.6, 0.5, 0.45)), "post_box": ("ポスト", (0.4, 0.4, 1.3)),
         "telephone": ("電話", (0.9, 0.9, 2.2)), "bicycle_parking": ("駐輪場", (2.0, 1.0, 1.0)), "waste_basket": ("ごみ箱", (0.5, 0.5, 0.9)),
         "toilets": ("トイレ", (3.0, 3.0, 3.0)), "bus_stop": ("バス停", (0.3, 0.3, 2.5)), "sign": ("標識", (0.1, 0.1, 2.5)),
         "street_cabinet": ("配電箱", (0.8, 0.4, 1.3)), "fire_hydrant": ("消火栓", (0.3, 0.3, 0.8)), "power_tower": ("鉄塔", (8, 8, 50))}


# ------------------------------------------------------------------ one section -> one .blend
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


def build_section(sec):
    reset()
    d = json.load(open(os.path.join(DATA, *sec["file"].split("/")), encoding="utf-8"))
    is_far = sec["level"] == "far"
    top = coll(("遠景_" if is_far else "区画_") + sec["id"].split("_", 1)[1], bpy.context.scene.collection)
    stats = {}

    # terrain over the section bounds
    x0, y0, x1, y1 = sec["bounds_local"]
    step = 15.0 if is_far else 4.0
    nx, ny = max(2, int((x1 - x0) / step) + 1), max(2, int((y1 - y0) / step) + 1)
    verts = [(x0 + (x1 - x0) * i / (nx - 1), y0 + (y1 - y0) * j / (ny - 1), 0.0) for j in range(ny) for i in range(nx)]
    # far terrains sit a little lower, so where sections overlap the finer ground shows (no flicker)
    sink = 0.0 if not is_far else (0.8 if sec["id"] == "far_outside" else 0.4)
    verts = [(x, y, ground(x, y) - sink) for x, y, _ in verts]
    faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i) for j in range(ny - 1) for i in range(nx - 1)]
    c_t = coll("地形", top)
    obj_from("地形", verts, faces, c_t, M_("地形"))
    stats["地形の点"] = len(verts)

    if is_far:
        # every building as a box, all in one mesh (thousands of boxes that never move)
        vs, fs = [], []
        for b in d["buildings"]:
            cx, cy, w, dpt, ang = b["box"]
            a = math.radians(ang); ca, sa = math.cos(a), math.sin(a)
            ring = [(cx + u * w / 2 * ca - v * dpt / 2 * sa, cy + u * w / 2 * sa + v * dpt / 2 * ca) for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            z0 = min(ground(x, y) for x, y in ring)
            v2, f2 = prism(ring, z0, z0 + b["h"])
            o = len(vs); vs += v2; fs += [tuple(i + o for i in f) for f in f2]
        c_b = coll("建物", top)
        obj_from("遠景の建物", vs, fs, c_b, M_("遠景"))
        stats["遠景の建物"] = len(d["buildings"])
        return top, stats

    # roads (one ground object for the carriageways, one for the paths) and crossings
    c_r = coll("道", top)
    rv, rf, pv, pf = [], [], [], []
    for r in d["roads"]:
        if len(r["pts"]) < 2 or str(r["tags"].get("tunnel", "no")) not in ("no", ""):
            continue
        w, car = road_width(r["kind"], r["tags"])
        lift = 0.06 if car else 0.08
        v2, f2 = ribbon(r["pts"], w, ground, lift)
        if car:
            o = len(rv); rv += v2; rf += [tuple(i + o for i in f) for f in f2]
        else:
            o = len(pv); pv += v2; pf += [tuple(i + o for i in f) for f in f2]
    obj_from("車道", rv, rf, c_r, M_("道"))
    obj_from("歩道と小道", pv, pf, c_r, M_("歩道"))
    stats["道"] = len(d["roads"])

    # buildings: one object each
    c_b = coll("建物", top)
    blds = [b for b in d["buildings"] if len(b["fp"]) >= 3]
    for i, b in enumerate(blds, 1):
        ring = [tuple(p) for p in b["fp"]]
        if ring_area(ring) < 0:
            ring.reverse()
        z0 = min(ground(x, y) for x, y in ring) + (b.get("minH") or 0)
        kind = b.get("kind")
        h = b["h"] if kind != "shed" else 2.6
        v2, f2 = prism(ring, z0, z0 + h)
        o = obj_from(serial("建物", i, len(blds)), v2, f2, c_b, M_("高い建物" if (kind == "tower" or h >= 30) else "屋根だけ" if kind == "shed" else "建物"))
        if o:
            for k in ("name", "use", "kind", "hSrc", "id"):
                if b.get(k) is not None:
                    o[{"name": "名前", "use": "用途", "kind": "種類", "hSrc": "高さの出どころ", "id": "osm"}[k]] = b[k]
            o["高さ"] = h
    stats["建物"] = len(blds)

    # point things: one object each, sharing the meshes
    SH = shared_meshes()
    groups, cols = {}, {}
    for p in d["points"]:
        groups.setdefault(p["kind"], []).append(p)
    def place(kind, cname, mesh, label, scale_fn=None, rot=True, ground_lift=0.0):
        lst = groups.get(kind, [])
        if not lst:
            return
        c = cols.get(cname) or cols.setdefault(cname, coll(cname, top))      # one collection per name
        for i, p in enumerate(lst, 1):
            x, y = p["p"]
            o = bpy.data.objects.new(serial(label, i, len(lst)), mesh)
            o.location = (x, y, ground(x, y) + ground_lift)
            if rot and p.get("a") is not None:
                o.rotation_euler[2] = math.radians(p["a"])
            if scale_fn:
                o.scale = scale_fn(p)
            if p.get("auto"):
                o["自動"] = True
            if p.get("src"):
                o["出どころ"] = p["src"]
            c.objects.link(o)
        stats[cname] = stats.get(cname, 0) + len(lst)
    place("tree", "木", SH["tree"], "木", lambda p: ((p.get("r") or 2.2) / 2.2,) * 3, rot=False)
    place("utility_pole", "電柱", SH["pole"], "電柱")
    place("street_lamp", "街灯", SH["lamp"], "街灯")
    place("traffic_signals", "信号", SH["signal"], "信号")
    for kind, (label, size) in SMALL.items():
        if groups.get(kind):
            place(kind, "小物" if kind not in ("bus_stop", "sign") else "標識とバス停", SH["box"], label, lambda p, s=size: s)

    # crossings: flat white plates on the road, one object (ground type)
    cv, cf = [], []
    for p in groups.get("crossing", []):
        x, y = p["p"]; a = math.radians(p.get("a") or 0); w = p.get("w") or 6; dd = p.get("d") or 4
        ca, sa = math.cos(a), math.sin(a)
        ring = [(x + u * dd / 2 * ca - v * w / 2 * sa, y + u * dd / 2 * sa + v * w / 2 * ca) for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        o = len(cv); cv += [(px, py, ground(px, py) + 0.1) for px, py in ring]; cf.append((o, o + 1, o + 2, o + 3))
    if cv:
        obj_from("横断歩道", cv, cf, coll("横断歩道", top), M_("白線"))
        stats["横断歩道"] = len(cf)

    # walls and fences (per line), wires (one curve per section)
    bars = d.get("barriers") or []
    if bars:
        c = coll("柵と塀", top)
        for i, b in enumerate(bars, 1):
            hgt = 1.5 if "wall" in b["kind"] else 1.2
            pts = b["pts"]; vs, fs = [], []
            for k, (x, y) in enumerate(pts):
                g = ground(x, y); vs += [(x, y, g), (x, y, g + hgt)]
                if k:
                    j = len(vs) - 4; fs.append((j, j + 2, j + 3, j + 1))
            obj_from(serial("柵", i, len(bars)), vs, fs, c, M_("柵"))
        stats["柵と塀"] = len(bars)
    wires = [w for w in (d.get("power") or []) if len(w["pts"]) >= 2]
    if wires:
        cu = bpy.data.curves.new("電線", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = 0.02
        for w in wires:
            sp = cu.splines.new("POLY"); sp.points.add(len(w["pts"]) - 1)
            for k, (x, y) in enumerate(w["pts"]):
                sp.points[k].co = (x, y, ground(x, y) + 8.5, 1)
        cu.materials.append(M_("電線"))
        o = bpy.data.objects.new("電線", cu)
        c = coll("電線", top); c.objects.link(o)
        # origin at the bottom centre: move the curve points
        xs = [p.co[0] for s in cu.splines for p in s.points]; ys = [p.co[1] for s in cu.splines for p in s.points]; zs = [p.co[2] for s in cu.splines for p in s.points]
        org = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs))
        for s in cu.splines:
            for p in s.points:
                p.co = (p.co[0] - org[0], p.co[1] - org[1], p.co[2] - org[2], 1)
        o.location = org
        stats["電線"] = len(wires)
    return top, stats


def save(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)


SEC_DIR = os.path.join(ROOT, "区画")
made = []
for sec in M["sections"]:
    top, stats = build_section(sec)
    path = os.path.join(SEC_DIR, sec["id"] + ".blend")
    save(path)
    made.append((sec, path, top.name))
    print("[rokehan] section", sec["id"], stats)

# ------------------------------------------------------------------ parent: link every section, add a sun and a camera
reset()
parent_path = os.path.join(ROOT, PLACE + ".blend")
save(parent_path)                                  # saved first, so the links can be relative
scene = bpy.context.scene
c_all = coll("区画", scene.collection)
for sec, path, cname in made:
    with bpy.data.libraries.load(path, link=True, relative=True) as (src, dst):
        dst.collections = [cname]
    for c in dst.collections:
        if c:
            c_all.children.link(c)
c_light = coll("環境光", scene.collection)
sun = bpy.data.objects.new("太陽", bpy.data.lights.new("太陽", "SUN"))
sun.data.energy = 3.0; sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
c_light.objects.link(sun)
c_cam = coll("カメラ", scene.collection)
det = [r for r in M["ranges"] if r["level"] == "detail"] or M["ranges"]
xs = [p[0] for r in det for p in r["ring_local"]]; ys = [p[1] for r in det for p in r["ring_local"]]
span = max(max(xs) - min(xs), max(ys) - min(ys))
# 中心点: where the far boards are shot from (the app's 📷 point; exports before 2026-11-20 have none, so the middle of
# the most detailed ranges, which is what the app uses when the point is not placed)
VP = M.get("viewpoint")
if VP:
    cx, cy = VP["local"]; vp_h = VP.get("h", 1.6); vp_auto = VP.get("auto", True)
else:
    lv = next(l for l in ("detail", "mid", "far") if any(r["level"] == l for r in M["ranges"]))
    pts = [p for r in M["ranges"] if r["level"] == lv and not r.get("outside") for p in r["ring_local"]]
    cx, cy = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2, (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
    vp_h, vp_auto = 1.6, True
gz = ground(cx, cy)
vp = bpy.data.objects.new("中心点", None)
vp.empty_display_type = "SINGLE_ARROW"; vp.empty_display_size = 6
vp.location = (cx, cy, gz)
vp["撮る高さ_m"] = vp_h; vp["自動"] = bool(vp_auto)
coll("中心点", scene.collection).objects.link(vp)          # cameras keep a collection of their own (skill rule)
eye = bpy.data.objects.new("中心点カメラ", bpy.data.cameras.new("中心点カメラ"))
eye.data.lens = 24; eye.data.clip_end = 20000
eye.location = (0, 0, vp_h); eye.rotation_euler = (math.radians(90), 0, 0)      # looks north; turn it to look around
eye.parent = vp
c_cam.objects.link(eye)
cam = bpy.data.objects.new("カメラ", bpy.data.cameras.new("カメラ"))
cam.data.lens = 28; cam.data.clip_end = 20000
cam.location = (cx, cy - span * 0.95, gz + span * 0.75)
cam.rotation_euler = (math.radians(58), 0, 0)
c_cam.objects.link(cam)
scene.camera = cam
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene["rokehan"] = json.dumps({"name": NAME, "zone": M["zone"], "origin_plane": M["origin"]["plane"]}, ensure_ascii=False)
save(parent_path)
print("[rokehan] parent", parent_path)
print("[rokehan] done", len(made), "sections")
