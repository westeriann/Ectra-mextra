export type RGB = [number, number, number];

let counter = 0;
/** Short unique id, readable in saved files. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const fract = (v: number) => v - Math.floor(v);
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

const colorCache = new Map<string, RGB>();
/** Parse #rgb / #rrggbb into 0..1 floats. Unknown input returns white. */
export function hexToRgb(hex: string): RGB {
  const hit = colorCache.get(hex);
  if (hit) return hit;
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const rgb: RGB = Number.isNaN(n) || h.length !== 6 ? [1, 1, 1] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  colorCache.set(hex, rgb);
  return rgb;
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** HSV with h in 0..1 → RGB. Lasers are pure, saturated colours so HSV is the natural space. */
export function hsv(h: number, s = 1, v = 1): RGB {
  h = fract(h) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** Deterministic hash of two ints to 0..1 (used for 'scatter' so frames are reproducible). */
export function hash2(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/** Format seconds as m:ss.t */
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
