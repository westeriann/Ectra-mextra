// Beam tracing through the stage: beams stop at solid objects (screens, walls,
// risers…), bounce off mirrors, and split into many beams on a mirror ball.
// Pure maths (no three.js) so it can be unit-tested.

import type { Stage } from './types';
import { hash2, rad } from './util';

export type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const reflect = (d: V3, n: V3): V3 => sub(d, mul(n, 2 * dot(d, n)));

/** Rotate around the vertical axis (same convention as three.js rotation.y). */
const rotY = (v: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};

interface Box {
  id: string;
  center: V3;
  half: V3;
  rot: number;
}
interface Mirror {
  id: string;
  center: V3;
  normal: V3;
  u: V3;
  v: V3;
  halfW: number;
  halfH: number;
}
interface Ball {
  id: string;
  center: V3;
  radius: number;
  spin: number;
}

export interface TraceScene {
  floorY: number;
  boxes: Box[];
  mirrors: Mirror[];
  balls: Ball[];
}

/** Element kinds that block beams when occlusion is on. */
const SOLID = new Set(['platform', 'wall', 'screen', 'speaker', 'pillar']);

export function buildTraceScene(stage: Stage): TraceScene {
  const floor = stage.elements.find((e) => e.kind === 'floor');
  const scene: TraceScene = { floorY: floor ? floor.position[1] + floor.size[1] : 0, boxes: [], mirrors: [], balls: [] };
  for (const el of stage.elements) {
    const [x, y, z] = el.position;
    const [w, h, d] = el.size;
    if (el.kind === 'mirror') {
      const yaw = rad(el.rotation);
      const tilt = rad(el.tilt ?? 0);
      // Matches the renderer: rotation order YXZ with rotation.x = -tilt.
      const n = rotY([0, Math.sin(tilt), Math.cos(tilt)], yaw);
      const v = rotY([0, Math.cos(tilt), -Math.sin(tilt)], yaw);
      scene.mirrors.push({ id: el.id, center: [x, y + h / 2, z], normal: n, u: rotY([1, 0, 0], yaw), v, halfW: w / 2, halfH: h / 2 });
    } else if (el.kind === 'mirrorball') {
      scene.balls.push({ id: el.id, center: [x, y + w / 2, z], radius: w / 2, spin: el.spin ?? 0.1 });
    } else if (SOLID.has(el.kind) && stage.occlusion !== false) {
      scene.boxes.push({ id: el.id, center: [x, y + h / 2, z], half: [w / 2, h / 2, d / 2], rot: rad(el.rotation) });
    }
  }
  return scene;
}

interface Hit {
  t: number;
  normal: V3;
  kind: 'solid' | 'floor' | 'mirror' | 'ball';
  id?: string;
}

/** Nearest hit of a ray with an oriented box, ignoring boxes the ray starts inside. */
export function rayBox(o: V3, d: V3, box: Box): Hit | null {
  const lo = rotY(sub(o, box.center), -box.rot);
  const ld = rotY(d, -box.rot);
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = 0;
  let sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < 1e-12) {
      if (Math.abs(lo[i]) > box.half[i]) return null;
      continue;
    }
    let t1 = (-box.half[i] - lo[i]) / ld[i];
    let t2 = (box.half[i] - lo[i]) / ld[i];
    let s = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tNear) {
      tNear = t1;
      axis = i;
      sign = s;
    }
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return null;
  }
  if (tNear <= 1e-4) return null; // behind, or starting inside (e.g. a laser mounted in a riser)
  const n: V3 = [0, 0, 0];
  n[axis] = sign;
  return { t: tNear, normal: rotY(n, box.rot), kind: 'solid', id: box.id };
}

function rayMirror(o: V3, d: V3, m: Mirror): Hit | null {
  const denom = dot(d, m.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(m.center, o), m.normal) / denom;
  if (t <= 1e-4) return null;
  const p = sub(add(o, mul(d, t)), m.center);
  if (Math.abs(dot(p, m.u)) > m.halfW || Math.abs(dot(p, m.v)) > m.halfH) return null;
  // Both faces reflect; return the normal facing the incoming beam.
  return { t, normal: denom > 0 ? mul(m.normal, -1) : m.normal, kind: 'mirror', id: m.id };
}

function raySphere(o: V3, d: V3, b: Ball): Hit | null {
  const oc = sub(o, b.center);
  const bq = dot(oc, d);
  const c = dot(oc, oc) - b.radius * b.radius;
  const disc = bq * bq - c;
  if (disc < 0) return null;
  const t = -bq - Math.sqrt(disc);
  if (t <= 1e-4) return null;
  return { t, normal: norm(add(oc, mul(d, t))), kind: 'ball', id: b.id };
}

export interface Segment {
  origin: V3;
  dir: V3;
  length: number;
  /** Distance the light has already travelled before this segment (for fading). */
  start: number;
  /** Brightness multiplier (drops at each bounce/split). */
  gain: number;
  /** Where the segment ends on a surface (for a hit spot), if it does. */
  hit: { point: V3; normal: V3; kind: Hit['kind'] } | null;
}

export interface TraceOptions {
  maxLength: number;
  maxDepth: number;
  /** Beams a mirror ball splits each hitting beam into. */
  ballSplits: number;
  /** Seconds — mirror balls rotate over time. */
  time: number;
  /** Shared budget so a mirror ball can't explode the beam count. */
  budget: { segments: number };
}

export const DEFAULT_TRACE: Omit<TraceOptions, 'budget' | 'time'> = { maxLength: 140, maxDepth: 3, ballSplits: 10 };

function nearest(scene: TraceScene, o: V3, d: V3, skip?: string): Hit | null {
  let best: Hit | null = null;
  const consider = (h: Hit | null) => {
    if (h && (!skip || h.id !== skip) && (!best || h.t < best.t)) best = h;
  };
  if (d[1] < -1e-6 && o[1] > scene.floorY) consider({ t: (scene.floorY - o[1]) / d[1], normal: [0, 1, 0], kind: 'floor' });
  for (const b of scene.boxes) consider(rayBox(o, d, b));
  for (const m of scene.mirrors) consider(rayMirror(o, d, m));
  for (const b of scene.balls) consider(raySphere(o, d, b));
  return best;
}

/** Trace one beam into a list of straight segments. */
export function traceBeam(scene: TraceScene, origin: V3, dir: V3, opts: TraceOptions, gain = 1, travelled = 0, depth = 0, skip?: string): Segment[] {
  if (opts.budget.segments <= 0) return [];
  opts.budget.segments--;
  const remaining = opts.maxLength - travelled;
  const hit = nearest(scene, origin, dir, skip);
  if (!hit || hit.t >= remaining) {
    return [{ origin, dir, length: remaining, start: travelled, gain, hit: null }];
  }
  const point = add(origin, mul(dir, hit.t));
  const seg: Segment = { origin, dir, length: hit.t, start: travelled, gain, hit: { point, normal: hit.normal, kind: hit.kind } };
  const out = [seg];
  if (depth >= opts.maxDepth) return out;
  const dist = travelled + hit.t;
  if (hit.kind === 'mirror') {
    out.push(...traceBeam(scene, point, reflect(dir, hit.normal), opts, gain * 0.85, dist, depth + 1, hit.id));
  } else if (hit.kind === 'ball') {
    const ball = scene.balls.find((b) => b.id === hit.id)!;
    const spin = opts.time * ball.spin * Math.PI * 2;
    for (let k = 0; k < opts.ballSplits; k++) {
      // Each split hits a different (rotating) facet of the ball.
      const jitter = rotY([(hash2(k, 11) - 0.5) * 1.2, (hash2(k, 12) - 0.5) * 1.2, (hash2(k, 13) - 0.5) * 1.2], spin + k * 0.7);
      const facet = norm(add(hit.normal, jitter));
      let out2 = reflect(dir, facet);
      if (dot(out2, hit.normal) < 0) out2 = reflect(out2, hit.normal);
      out.push(...traceBeam(scene, point, norm(out2), opts, gain * 0.45, dist, depth + 1, hit.id));
    }
  }
  return out;
}
