// ILDA Image Data Transfer Format (.ild) reader/writer.
// Supports formats 0 (3D indexed), 1 (2D indexed), 4 (3D true colour) and
// 5 (2D true colour). Indexed colours use the standard ILDA 64-colour palette.

import type { Shape, ShapePoint } from './types';
import { hsv, uid } from './util';

/** The ILDA default palette (approximate) — 64 entries generated around the hue wheel plus white. */
const PALETTE: [number, number, number][] = (() => {
  const p: [number, number, number][] = [];
  for (let i = 0; i < 56; i++) p.push(hsv(i / 56));
  for (let i = 0; i < 8; i++) {
    const v = 1 - i / 8;
    p.push([v, v, v]);
  }
  p[0] = [1, 0, 0];
  return p;
})();

export function parseIlda(buf: ArrayBuffer, name = 'Shape'): Shape {
  const view = new DataView(buf);
  const frames: ShapePoint[][] = [];
  let off = 0;
  let frameName = name;
  while (off + 32 <= view.byteLength) {
    const magic = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    if (magic !== 'ILDA') throw new Error('Not an ILDA file (bad header).');
    const format = view.getUint8(off + 7);
    const label = readString(view, off + 8, 8);
    if (label && frames.length === 0) frameName = label;
    const count = view.getUint16(off + 24);
    off += 32;
    if (count === 0) break; // end-of-file header
    const size = format === 0 ? 8 : format === 1 ? 6 : format === 4 ? 10 : format === 5 ? 8 : format === 2 ? 3 : 0;
    if (!size) throw new Error(`Unsupported ILDA format ${format}.`);
    if (format === 2) {
      off += count * 3; // palette section — use the default palette
      continue;
    }
    const pts: ShapePoint[] = [];
    for (let i = 0; i < count && off + size <= view.byteLength; i++) {
      const x = view.getInt16(off) / 32768;
      const y = view.getInt16(off + 2) / 32768;
      const statusAt = format === 0 || format === 4 ? off + 6 : off + 4;
      const status = view.getUint8(statusAt);
      const blank = (status & 0x40) !== 0;
      let r: number, g: number, b: number;
      if (format === 0 || format === 1) {
        [r, g, b] = PALETTE[view.getUint8(statusAt + 1) % PALETTE.length];
      } else {
        // True colour is stored blue, green, red.
        b = view.getUint8(statusAt + 1) / 255;
        g = view.getUint8(statusAt + 2) / 255;
        r = view.getUint8(statusAt + 3) / 255;
      }
      pts.push({ x, y, r, g, b, blank });
      off += size;
    }
    frames.push(pts);
  }
  if (!frames.length) throw new Error('ILDA file contains no frames.');
  return { id: uid('shape'), name: frameName || name, frames };
}

/** Write shapes as format 5 (2D true colour) — the most widely supported modern format. */
export function writeIlda(shape: Shape): ArrayBuffer {
  const total = shape.frames.reduce((s, f) => s + 32 + f.length * 8, 0) + 32;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  let off = 0;
  const header = (count: number, frame: number) => {
    'ILDA'.split('').forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
    view.setUint8(off + 7, 5);
    writeString(view, off + 8, shape.name, 8);
    writeString(view, off + 16, 'LSTUDIO', 8);
    view.setUint16(off + 24, count);
    view.setUint16(off + 26, frame);
    view.setUint16(off + 28, shape.frames.length);
    off += 32;
  };
  shape.frames.forEach((pts, fi) => {
    header(pts.length, fi);
    pts.forEach((p, i) => {
      view.setInt16(off, Math.round(Math.max(-1, Math.min(1, p.x)) * 32767));
      view.setInt16(off + 2, Math.round(Math.max(-1, Math.min(1, p.y)) * 32767));
      view.setUint8(off + 4, (p.blank ? 0x40 : 0) | (i === pts.length - 1 ? 0x80 : 0));
      view.setUint8(off + 5, Math.round(p.b * 255));
      view.setUint8(off + 6, Math.round(p.g * 255));
      view.setUint8(off + 7, Math.round(p.r * 255));
      off += 8;
    });
  });
  header(0, shape.frames.length);
  return buf;
}

function readString(v: DataView, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function writeString(v: DataView, at: number, s: string, len: number) {
  for (let i = 0; i < len; i++) v.setUint8(at + i, i < s.length ? s.charCodeAt(i) & 0x7f : 0);
}

/** A few built-in shapes so the shape effect is usable without importing files. */
export function builtinShapes(): Shape[] {
  const poly = (name: string, n: number, star = false): Shape => {
    const pts: ShapePoint[] = [];
    const steps = star ? n * 2 : n;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2 + Math.PI / 2;
      const r = star && i % 2 ? 0.45 : 1;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: 0, g: 1, b: 0, blank: i === 0 });
    }
    return { id: `builtin_${name.toLowerCase()}`, name, frames: [pts] };
  };
  const heart: ShapePoint[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    heart.push({ x: (16 * Math.sin(t) ** 3) / 17, y: (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17, r: 1, g: 0, b: 0.3, blank: i === 0 });
  }
  return [poly('Circle', 48), poly('Square', 4), poly('Star', 5, true), poly('Hexagon', 6), { id: 'builtin_heart', name: 'Heart', frames: [heart] }];
}
