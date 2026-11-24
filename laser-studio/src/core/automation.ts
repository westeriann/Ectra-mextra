// Timeline automation: curves that modify every running look over the course
// of a song (e.g. intensity rising into a drop, speed doubling, colour drift).
// Plus "morph" crossfades that move beams from one look into the next.

import type { Beam } from './types';
import { clamp, fract, hsv } from './util';

export const AUTO_PARAMS = {
  intensity: { label: 'Intensity', min: 0, max: 1, neutral: 1, kind: 'mul', unit: '%' },
  speed: { label: 'Speed', min: 0, max: 4, neutral: 1, kind: 'mul', unit: '×' },
  size: { label: 'Size', min: 0, max: 3, neutral: 1, kind: 'mul', unit: '×' },
  spread: { label: 'Spread', min: 0, max: 3, neutral: 1, kind: 'mul', unit: '×' },
  pan: { label: 'Pan', min: -90, max: 90, neutral: 0, kind: 'add', unit: '°' },
  tilt: { label: 'Tilt', min: -45, max: 45, neutral: 0, kind: 'add', unit: '°' },
  hue: { label: 'Colour shift', min: 0, max: 1, neutral: 0, kind: 'add', unit: '' },
} as const;
export type AutoParam = keyof typeof AUTO_PARAMS;
export const AUTO_PARAM_IDS = Object.keys(AUTO_PARAMS) as AutoParam[];

/** How the curve gets from this point to the next one. */
export type CurveShape = 'linear' | 'smooth' | 'hold';

export interface AutoPoint {
  id: string;
  time: number;
  value: number;
  curve: CurveShape;
}

export interface AutomationLane {
  id: string;
  param: AutoParam;
  /** 'all' or a fixture group name. */
  target: string;
  enabled: boolean;
  points: AutoPoint[];
}

export function formatAutoValue(param: AutoParam, v: number): string {
  const p = AUTO_PARAMS[param];
  if (p.unit === '%') return `${Math.round(v * 100)}%`;
  if (p.unit === '×') return `${v.toFixed(2)}×`;
  if (p.unit === '°') return `${Math.round(v)}°`;
  return v.toFixed(2);
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function sorted(lane: AutomationLane): AutoPoint[] {
  // Points are kept sorted by the editor; this is a cheap guard for hand-edited files.
  const pts = lane.points;
  for (let i = 1; i < pts.length; i++) if (pts[i].time < pts[i - 1].time) return [...pts].sort((a, b) => a.time - b.time);
  return pts;
}

/** Curve value at time t. Before the first / after the last point the value is held. */
export function laneValue(lane: AutomationLane, t: number): number {
  const pts = sorted(lane);
  if (!pts.length) return AUTO_PARAMS[lane.param].neutral;
  if (t <= pts[0].time) return pts[0].value;
  const last = pts[pts.length - 1];
  if (t >= last.time) return last.value;
  // Binary search for the segment containing t.
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (a.curve === 'hold' || b.time === a.time) return a.value;
  let u = (t - a.time) / (b.time - a.time);
  if (a.curve === 'smooth') u = smoothstep(u);
  return a.value + (b.value - a.value) * u;
}

/**
 * ∫ product of the lanes' values dt from t0 to t1. Used for speed automation so
 * effect phase stays continuous while the speed ramps (no jumps).
 */
export function integrateProduct(lanes: AutomationLane[], t0: number, t1: number): number {
  if (t1 === t0) return 0;
  if (t1 < t0) return -integrateProduct(lanes, t1, t0);
  const breaks = new Set<number>([t0, t1]);
  for (const l of lanes) for (const p of l.points) if (p.time > t0 && p.time < t1) breaks.add(p.time);
  const xs = [...breaks].sort((a, b) => a - b);
  const f = (t: number) => lanes.reduce((m, l) => m * laneValue(l, t), 1);
  let sum = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    // Simpson's rule on 4 sub-steps: exact for linear×linear, very close for smooth.
    const a = xs[i];
    const b = xs[i + 1];
    const n = 4;
    const h = (b - a) / n;
    // Evaluate just inside the ends so "hold" steps use the segment's own value.
    const eps = Math.min(1e-9, h * 1e-6);
    let s = f(a + eps) + f(b - eps);
    for (let k = 1; k < n; k++) s += f(a + k * h) * (k % 2 ? 4 : 2);
    sum += (s * h) / 3;
  }
  return sum;
}

export interface Modifiers {
  intensity: number;
  size: number;
  spread: number;
  pan: number;
  tilt: number;
  hue: number;
  /** Speed lanes affecting this fixture (integrated by the engine). */
  speedLanes: AutomationLane[];
}

export const NEUTRAL: Modifiers = { intensity: 1, size: 1, spread: 1, pan: 0, tilt: 0, hue: 0, speedLanes: [] };

/** Combine every enabled lane that targets this fixture's group. */
export function modifiersAt(lanes: AutomationLane[], group: string, t: number): Modifiers {
  const m: Modifiers = { ...NEUTRAL, speedLanes: [] };
  for (const lane of lanes) {
    if (!lane.enabled || !lane.points.length) continue;
    if (lane.target !== 'all' && lane.target !== group) continue;
    if (lane.param === 'speed') {
      m.speedLanes.push(lane);
      continue;
    }
    const v = laneValue(lane, t);
    if (AUTO_PARAMS[lane.param].kind === 'mul') m[lane.param as 'intensity' | 'size' | 'spread'] *= v;
    else m[lane.param as 'pan' | 'tilt' | 'hue'] += v;
  }
  return m;
}

export function isNeutral(m: Modifiers): boolean {
  return m.intensity === 1 && m.size === 1 && m.spread === 1 && m.pan === 0 && m.tilt === 0 && m.hue === 0 && !m.speedLanes.length;
}

// ------------------------------------------------------------------ colour

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [fract(h), max === 0 ? 0 : d / max, max];
}

export function shiftHue(b: Beam, amount: number): Beam {
  if (!amount) return b;
  const [h, s, v] = rgbToHsv(b.r, b.g, b.b);
  const [r, g, bl] = hsv(h + amount, s, v);
  return { ...b, r, g, b: bl };
}

// ------------------------------------------------------------------ morph

/** Ease used for crossfades: slow in, slow out. */
export const easeInOut = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/**
 * Move beams from look A to look B. Both sets are ordered left-to-right and
 * resampled to the same count; beams that get duplicated are dimmed so the
 * overall brightness matches each look at the ends of the fade.
 */
export function morphBeams(a: Beam[], b: Beam[], t: number): Beam[] {
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (!a.length) return b.map((x) => ({ ...x, a: x.a * t }));
  if (!b.length) return a.map((x) => ({ ...x, a: x.a * (1 - t) }));
  const order = (x: Beam, y: Beam) => x.x - y.x || x.y - y.y;
  const A = [...a].sort(order);
  const B = [...b].sort(order);
  const n = Math.max(A.length, B.length);
  const pick = (list: Beam[]) => {
    const idx = Array.from({ length: n }, (_, i) => Math.floor((i * list.length) / n));
    const mult = new Map<number, number>();
    for (const i of idx) mult.set(i, (mult.get(i) ?? 0) + 1);
    return idx.map((i) => ({ beam: list[i], share: 1 / mult.get(i)! }));
  };
  const pa = pick(A);
  const pb = pick(B);
  const out: Beam[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    out[i] = {
      x: x.beam.x + (y.beam.x - x.beam.x) * t,
      y: x.beam.y + (y.beam.y - x.beam.y) * t,
      r: x.beam.r + (y.beam.r - x.beam.r) * t,
      g: x.beam.g + (y.beam.g - x.beam.g) * t,
      b: x.beam.b + (y.beam.b - x.beam.b) * t,
      a: x.beam.a * x.share * (1 - t) + y.beam.a * y.share * t,
    };
  }
  return out;
}
