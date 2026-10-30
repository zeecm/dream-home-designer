/** Checks and names for uploaded furniture models (pure, so tests need no browser). */

/** As the API's MaxModelBytes. */
export const MAX_MODEL_BYTES = 20 << 20;

/** True for a binary glTF 2.0 whose header length matches, as the API checks. */
export function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 20) return false;
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  return magic === 'glTF' && v.getUint32(4, true) === 2 && v.getUint32(8, true) === buf.byteLength;
}

/**
 * A model's size in metres (width x, depth z, height y). glTF is in metres, but models
 * exported from some tools are in centimetres or millimetres: nothing in a flat is 20 m
 * across, so a larger model is read as centimetres, and one over 2 km as millimetres.
 */
export function modelSize(size: { x: number; y: number; z: number }) {
  const biggest = Math.max(size.x, size.y, size.z);
  const unit = biggest > 2000 ? 0.001 : biggest > 20 ? 0.01 : 1;
  const m = (n: number) => Math.max(0.01, Math.round(n * unit * 1000) / 1000);
  return { w: m(size.x), d: m(size.z), h: m(size.y) };
}

/** A name from the file's: "grandmas-armchair_v2.glb" → "Grandmas armchair v2". */
export function nameOfFile(file: string): string {
  const base = file
    .replace(/\.[^.]*$/, '')
    .replace(/[-_.]+/g, ' ')
    .trim();
  const name = base ? base[0]?.toUpperCase() + base.slice(1) : 'My model';
  return name.slice(0, 80);
}
