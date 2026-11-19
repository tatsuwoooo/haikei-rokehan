// GSI elevation tiles for the 3D view.
// GSI encodes height as (R*65536 + G*256 + B) * 0.01 m, with (128,0,0) = no data (sea). MapLibre cannot read that
// directly, so a "gsidem://z/x/y" protocol fetches the GSI tile and re-encodes it as Terrarium on the fly.
export const GSI_DEM = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
export const GSI_DEM5A = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`;

let flat = null;
async function flatTile() {           // 0 m everywhere (outside Japan / no tile)
  if (flat) return flat;
  const c = new OffscreenCanvas(256, 256), g = c.getContext("2d");
  g.fillStyle = "rgb(128,0,0)"; g.fillRect(0, 0, 256, 256);
  flat = await (await c.convertToBlob({type: "image/png"})).arrayBuffer();
  return flat;
}

export function gsiHeight(r, g, b) {
  const v = r * 65536 + g * 256 + b;
  if (v === 8388608) return null;            // no data
  return (v > 8388608 ? v - 16777216 : v) * 0.01;
}

export function registerGsiDem(maplibregl) {
  maplibregl.addProtocol("gsidem", async (params, abort) => {
    const [z, x, y] = params.url.replace("gsidem://", "").split("/").map(Number);
    let res;
    try { res = await fetch(GSI_DEM(z, x, y), {signal: abort.signal}); } catch (e) { if (abort.signal.aborted) throw e; }
    if (!res || !res.ok) return {data: await flatTile()};
    const bmp = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d", {willReadFrequently: true});
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, bmp.width, bmp.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const h = gsiHeight(d[i], d[i + 1], d[i + 2]) ?? 0;
      const t = h + 32768;
      d[i] = Math.floor(t / 256); d[i + 1] = Math.floor(t) % 256; d[i + 2] = Math.floor((t - Math.floor(t)) * 256); d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return {data: await (await c.convertToBlob({type: "image/png"})).arrayBuffer()};
  });
}
