// Minimal Mapbox Vector Tile decoder (protobuf), enough for buildings, roads, water and parks.
// decodeTile(bytes) -> { layerName: { extent, features: [{type, props, geom}] } }
// geom: for points [[x,y],...]; for lines/polygons an array of rings/lines, each [[x,y],...] in tile units (0..extent).

function reader(buf) {
  let pos = 0;
  const r = {
    get pos() { return pos; }, set pos(v) { pos = v; }, len: buf.length,
    varint() {
      let v = 0, s = 0, b;
      do { b = buf[pos++]; if (s < 28) v |= (b & 0x7f) << s; else v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
      return v >>> 0 === v ? v : v;
    },
    svarint() { const v = r.varint(); return (v % 2 === 1) ? (v + 1) / -2 : v / 2; },
    bytes() { const l = r.varint(), out = buf.subarray(pos, pos + l); pos += l; return out; },
    string() { return new TextDecoder().decode(r.bytes()); },
    double() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true); pos += 8; return v; },
    float() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return v; },
    skip(wire) {
      if (wire === 0) r.varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += r.varint();
      else if (wire === 5) pos += 4;
      else throw new Error("bad wire type " + wire);
    },
  };
  return r;
}

function readValue(bytes) {
  const r = reader(bytes);
  let v = null;
  while (r.pos < r.len) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) v = r.string();
    else if (f === 2) v = r.float();
    else if (f === 3) v = r.double();
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = r.svarint();
    else if (f === 7) v = !!r.varint();
    else r.skip(w);
  }
  return v;
}

function readGeom(bytes, type) {
  const r = reader(bytes), parts = [];
  let x = 0, y = 0, cur = null;
  while (r.pos < r.len) {
    const ci = r.varint(), cmd = ci & 7, count = ci >> 3;
    if (cmd === 1 || cmd === 2) {
      for (let i = 0; i < count; i++) {
        x += r.svarint(); y += r.svarint();
        if (cmd === 1) { if (cur && type !== 1) parts.push(cur); cur = type === 1 ? (cur || []) : []; }
        cur.push([x, y]);
      }
    } else if (cmd === 7) {
      if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
    }
  }
  if (cur) parts.push(cur);
  return type === 1 ? parts.flat() : parts;
}

function readLayer(bytes) {
  const r = reader(bytes), keys = [], values = [], raw = [];
  let name = "", extent = 4096;
  while (r.pos < r.len) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) name = r.string();
    else if (f === 2) raw.push(r.bytes());
    else if (f === 3) keys.push(r.string());
    else if (f === 4) values.push(readValue(r.bytes()));
    else if (f === 5) extent = r.varint();
    else r.skip(w);
  }
  const features = raw.map(fb => {
    const fr = reader(fb);
    let type = 0, tags = [], geom = null, id = null;
    while (fr.pos < fr.len) {
      const tag = fr.varint(), f = tag >> 3, w = tag & 7;
      if (f === 1) id = fr.varint();
      else if (f === 2) { const b = fr.bytes(), tr = reader(b); while (tr.pos < tr.len) tags.push(tr.varint()); }
      else if (f === 3) type = fr.varint();
      else if (f === 4) geom = fr.bytes();
      else fr.skip(w);
    }
    const props = {};
    for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
    return {id, type, props, geom: geom ? readGeom(geom, type) : []};
  });
  return {name, extent, features};
}

export function decodeTile(bytes) {
  const r = reader(bytes), out = {};
  while (r.pos < r.len) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f === 3) { const l = readLayer(r.bytes()); out[l.name] = l; }
    else r.skip(w);
  }
  return out;
}

// Polygon features come as a flat list of rings: outer rings are clockwise in tile space (positive area
// with y down), holes the other way. Group them into [outer, ...holes].
export function polygons(rings) {
  const out = [];
  for (const ring of rings) {
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    if (s > 0 || !out.length) out.push([ring]); else out[out.length - 1].push(ring);   // s = 2 x signed area
  }
  return out;
}
