// Effect generators. Each one turns (effect params, phase, fixture index) into
// a list of beams in fixture-local angles. They are pure functions of time so
// the timeline can be scrubbed and the output window stays in sync.

import type { Beam, Effect, Fixture, Shape } from './types';
import { clamp, fract, hash2, hexToRgb, hsv, lerp, type RGB } from './util';

export interface EffectContext {
  /** Seconds on the show clock. */
  time: number;
  /** Beat position on the show clock. */
  beat: number;
  /** Index of this fixture among the fixtures running the effect, and how many there are. */
  index: number;
  count: number;
  fixture: Fixture;
  /** Audio level 0..1 (for audio-reactive effects). */
  level: number;
  shapes?: Shape[];
}

export const DEFAULT_EFFECT: Effect = {
  kind: 'fan',
  beams: 8,
  spread: 60,
  size: 20,
  speed: 0.25,
  sync: true,
  pan: 0,
  tilt: 0,
  colorMode: 'solid',
  color: '#00ff40',
  color2: '#0060ff',
  intensity: 1,
  strobe: 0,
  phaseSpread: 0,
  mirror: true,
  audioReact: 0,
};

/** Some effects only look right with many beams, regardless of the beam count. */
const MIN_BEAMS: Partial<Record<Effect['kind'], number>> = { cone: 16, tunnel: 48, sheet: 40, shape: 24 };

/** Total phase in cycles for an effect at a given moment. */
export function effectPhase(e: Effect, ctx: EffectContext): number {
  const base = e.sync ? ctx.beat * e.speed : ctx.time * e.speed;
  const offset = ctx.count > 1 ? (e.phaseSpread * ctx.index) / ctx.count : 0;
  return base + offset;
}

/** True when a strobing effect is in its "on" part of the cycle. */
export function strobeOn(e: Effect, ctx: EffectContext): boolean {
  if (e.strobe <= 0) return true;
  const p = e.sync ? ctx.beat * e.strobe : ctx.time * e.strobe;
  return fract(p) < 0.35;
}

function beamColor(e: Effect, i: number, n: number, phase: number): RGB {
  switch (e.colorMode) {
    case 'alternate':
      return hexToRgb(i % 2 === 0 ? e.color : e.color2);
    case 'gradient': {
      const a = hexToRgb(e.color);
      const b = hexToRgb(e.color2);
      const t = n > 1 ? i / (n - 1) : 0;
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    }
    case 'rainbow':
      return hsv(i / Math.max(n, 1) + phase * 0.25);
    default:
      return hexToRgb(e.color);
  }
}

/** Compute the beams one fixture emits for an effect. */
export function computeBeams(e: Effect, ctx: EffectContext): Beam[] {
  if (e.intensity <= 0 || !strobeOn(e, ctx)) return [];
  const p = effectPhase(e, ctx);
  const cap = Math.max(1, ctx.fixture.maxBeams);
  const want = Math.max(e.beams, MIN_BEAMS[e.kind] ?? 1);
  // Dense "air" effects are drawn as many faint beams, so they may exceed the hardware cap.
  const n = Math.max(1, Math.round(MIN_BEAMS[e.kind] ? Math.min(want, 128) : Math.min(want, cap)));
  const tau = Math.PI * 2;
  const s = e.spread;
  const size = e.size;
  const mirror = e.mirror && ctx.fixture.position[0] > 0.01 ? -1 : 1;
  let level = 1;
  if (e.audioReact > 0) level = lerp(1, clamp(ctx.level * 1.6, 0, 1.4), e.audioReact);
  const baseA = clamp(e.intensity * ctx.fixture.power * level, 0, 1.5);

  const out: Beam[] = [];
  const push = (x: number, y: number, c: RGB, a = 1) => {
    out.push({ x: x * mirror + e.pan, y: y + e.tilt, r: c[0], g: c[1], b: c[2], a: a * baseA });
  };

  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) - 0.5 : 0;
    const c = beamColor(e, i, n, p);
    switch (e.kind) {
      case 'static':
        push(u * s, 0, c);
        break;
      case 'fan':
        push(u * s + Math.sin(tau * p) * size, 0, c);
        break;
      case 'sweep':
        push(u * s * 0.15 + Math.sin(tau * p) * size, 0, c);
        break;
      case 'crossfan': {
        const dir = i % 2 === 0 ? 1 : -1;
        push(u * s * 0.3 + dir * Math.sin(tau * p) * size, 0, c);
        break;
      }
      case 'wave':
        push(u * s, Math.sin(tau * (p + u * 1.5)) * size * 0.5, c);
        break;
      case 'chase': {
        const head = fract(p) * n;
        let d = Math.abs(i - head);
        d = Math.min(d, n - d);
        const a = clamp(1 - d / Math.max(1, n * 0.18), 0, 1);
        if (a > 0.02) push(u * s, 0, c, a);
        break;
      }
      case 'cone': {
        const ang = tau * (i / n + p);
        push(Math.cos(ang) * size, Math.sin(ang) * size, c);
        break;
      }
      case 'tunnel': {
        const ang = tau * (i / n + p * 0.5);
        const r = size * (0.85 + 0.15 * Math.sin(tau * p * 2));
        push(Math.cos(ang) * r, Math.sin(ang) * r, c, 0.55);
        break;
      }
      case 'sheet':
        push(u * s, Math.sin(tau * p) * size * 0.5, c, 0.45);
        break;
      case 'spiral': {
        const t = i / n;
        const ang = tau * (t * 3 + p);
        push(Math.cos(ang) * size * t, Math.sin(ang) * size * t, c);
        break;
      }
      case 'scatter': {
        const step = Math.floor(p * 4);
        push((hash2(i, step) - 0.5) * s, (hash2(i + 999, step) - 0.5) * size, c);
        break;
      }
      case 'shape':
        // Handled below — needs the whole shape at once.
        break;
    }
  }

  if (e.kind === 'shape') {
    for (const pt of shapePoints(e, ctx, p, n)) push(pt.x * size, pt.y * size, pt.c, 0.6);
  }
  return out;
}

/** Points sampled along an imported ILDA shape (or a spinning triangle if none is set). */
function shapePoints(e: Effect, ctx: EffectContext, p: number, n: number): { x: number; y: number; c: RGB }[] {
  const shape = ctx.shapes?.find((s) => s.id === e.shapeId);
  const frames = shape?.frames.length ? shape.frames : null;
  const frame = frames ? frames[Math.floor(fract(p) * frames.length) % frames.length] : null;
  const lit = frame ? frame.filter((pt) => !pt.blank) : [];
  const pts: { x: number; y: number; c: RGB }[] = [];
  for (let i = 0; i < n; i++) {
    if (lit.length) {
      const pt = lit[Math.floor((i / n) * lit.length)];
      pts.push({ x: pt.x, y: pt.y, c: e.colorMode === 'source' ? [pt.r, pt.g, pt.b] : beamColor(e, i, n, p) });
    } else {
      const t = (i / n) * 3;
      const side = Math.floor(t);
      const f = t - side;
      const a0 = Math.PI * 2 * (side / 3 + p);
      const a1 = Math.PI * 2 * ((side + 1) / 3 + p);
      pts.push({ x: lerp(Math.cos(a0), Math.cos(a1), f), y: lerp(Math.sin(a0), Math.sin(a1), f), c: beamColor(e, i, n, p) });
    }
  }
  return pts;
}
