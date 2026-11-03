/** Typed arrays ⇄ base64 (little-endian bytes), for JSON transports and project files. */

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function f32ToBase64(a: Float32Array): string {
  return bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

/** Decodes into a fresh, aligned Float32Array (trailing partial floats are dropped). */
export function base64ToF32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  const out = new Float32Array(Math.floor(bytes.length / 4));
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.length * 4));
  return out;
}
