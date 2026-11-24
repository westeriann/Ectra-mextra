// Offline music analysis: waveform overview, tempo/beat detection and an
// "auto program" that lays cues on the timeline following the song's energy.
// Works on raw mono samples so it can be unit-tested without Web Audio.

import { makeCue } from './show';
import type { Cue, Show, TimelineCue, TimelineHit } from './types';
import { uid } from './util';

export interface Analysis {
  bpm: number;
  offset: number;
  duration: number;
  /** Min/max pairs for drawing the waveform. */
  peaks: Float32Array;
  /** Loudness per bar, 0..1 normalised. */
  barEnergy: number[];
  /** Times of strong onsets (big hits / drops). */
  accents: number[];
}

/** Mix an AudioBuffer-like set of channels down to mono. */
export function mixdown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Waveform overview: `buckets` min/max pairs. */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(samples.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

/**
 * Onset strength: positive change in (low-passed) energy per hop. Low-passing
 * first makes kick drums dominate, which is what tempo detection wants.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, hop = 512): { env: Float32Array; rate: number } {
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  const alpha = Math.exp((-2 * Math.PI * 180) / sampleRate); // ~180 Hz low-pass
  let lp = 0;
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    let eAll = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      lp = alpha * lp + (1 - alpha) * samples[i];
      e += lp * lp;
      eAll += samples[i] * samples[i];
    }
    const v = Math.log1p(1000 * (e + 0.25 * eAll) / hop);
    env[f] = Math.max(0, v - prev);
    prev = v;
  }
  return { env, rate: sampleRate / hop };
}

/** Light smoothing so single-frame onset spikes can be sampled between frames. */
export function smooth(env: Float32Array): Float32Array {
  const k = [1, 3, 4, 3, 1];
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += (env[i + j] ?? 0) * k[j + 2];
    out[i] = s / 12;
  }
  return out;
}

const sampleAt = (x: Float32Array, t: number) => {
  const i = Math.floor(t);
  const f = t - i;
  return (x[i] ?? 0) * (1 - f) + (x[i + 1] ?? 0) * f;
};

/** Coarse tempo by autocorrelation of the onset envelope, preferring 90–180 BPM. */
export function estimateBpm(env: Float32Array, rate: number, min = 70, max = 190): number {
  const x = smooth(env);
  const mean = x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  for (let i = 0; i < x.length; i++) x[i] -= mean;
  let best = 120;
  let bestScore = -Infinity;
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    let s = 0;
    for (let k = 1; k <= 2; k++) for (let i = 0; i + lag * k + 1 < x.length; i++) s += x[i] * sampleAt(x, i + lag * k);
    // Mild preference for dance tempos so half/double-time ties resolve sensibly.
    s *= bpm >= 90 && bpm <= 180 ? 1 : 0.85;
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return fitGrid(env, rate, best).bpm;
}

/**
 * Fit a constant-tempo beat grid: search tempo (±1.5 BPM around a guess) and
 * phase together, scoring how much onset energy lands on the grid over the whole song.
 */
export function fitGrid(env: Float32Array, rate: number, guess: number): { bpm: number; offset: number } {
  const x = smooth(env);
  let best = { bpm: guess, offset: 0, score: -Infinity };
  const search = (lo: number, hi: number, step: number) => {
    for (let bpm = lo; bpm <= hi + 1e-9; bpm += step) {
      const period = (60 / bpm) * rate;
      const phases = 48;
      for (let k = 0; k < phases; k++) {
        const phase = (k / phases) * period;
        let s = 0;
        for (let t = phase; t < x.length; t += period) s += sampleAt(x, t);
        if (s > best.score) best = { bpm, offset: phase / rate, score: s };
      }
    }
  };
  search(guess - 1.5, guess + 1.5, 0.1);
  const coarse = best.bpm;
  search(coarse - 0.1, coarse + 0.1, 0.01);
  return { bpm: Math.round(best.bpm * 100) / 100, offset: best.offset };
}

/** Where the beat grid lines up best with the onsets (first beat, seconds). */
export function estimateOffset(env: Float32Array, rate: number, bpm: number): number {
  const x = smooth(env);
  const period = (60 / bpm) * rate;
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 128; k++) {
    const phase = (k / 128) * period;
    let s = 0;
    for (let t = phase; t < x.length; t += period) s += sampleAt(x, t);
    if (s > bestScore) {
      bestScore = s;
      best = phase;
    }
  }
  return best / rate;
}

export function analyze(samples: Float32Array, sampleRate: number, beatsPerBar = 4): Analysis {
  const duration = samples.length / sampleRate;
  const { env, rate } = onsetEnvelope(samples, sampleRate);
  const bpm = estimateBpm(env, rate);
  const offset = estimateOffset(env, rate, bpm);
  const barLen = (60 / bpm) * beatsPerBar;

  // RMS per bar.
  const barEnergy: number[] = [];
  for (let t = offset; t < duration; t += barLen) {
    const a = Math.floor(t * sampleRate);
    const b = Math.min(samples.length, Math.floor((t + barLen) * sampleRate));
    let e = 0;
    for (let i = a; i < b; i += 4) e += samples[i] * samples[i];
    barEnergy.push(Math.sqrt(e / Math.max(1, (b - a) / 4)));
  }
  const maxE = Math.max(1e-9, ...barEnergy);
  const normalized = barEnergy.map((e) => e / maxE);

  // Accents: bars where energy jumps sharply (drops), placed on the downbeat.
  const accents: number[] = [];
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] - normalized[i - 1] > 0.3 && normalized[i] > 0.6) accents.push(offset + i * barLen);
  }

  return { bpm, offset, duration, peaks: computePeaks(samples, 4000), barEnergy: normalized, accents };
}

/** Rough "how intense is this cue" score so auto-program can match cues to song energy. */
export function cueEnergy(cue: Cue): number {
  const looks = Object.values(cue.looks).filter((l) => l.on);
  if (!looks.length) return 0;
  let s = 0;
  for (const { effect: e } of looks) {
    const speed = e.sync ? e.speed : e.speed / 2;
    s += Math.min(speed, 2) * 0.5 + (e.strobe > 0 ? 0.6 : 0) + Math.min(e.beams, 24) / 48 + e.intensity * 0.3;
    if (e.kind === 'sheet' || e.kind === 'tunnel') s -= 0.2;
    if (e.kind === 'chase' || e.kind === 'scatter' || e.kind === 'crossfan') s += 0.2;
  }
  return s / looks.length;
}

export interface AutoProgramOptions {
  /** Change cue every N bars. */
  barsPerCue: number;
  /** Add flash hits on detected drops. */
  accents: boolean;
}

/**
 * Lay cues along the song: quiet bars get calm cues, loud bars get intense
 * ones, cue changes happen on phrase boundaries, and drops get a flash.
 */
export function autoProgram(show: Show, a: Analysis, opts: AutoProgramOptions): { cues: TimelineCue[]; hits: TimelineHit[]; added: Cue[] } {
  let pool = show.cues.filter((c) => Object.values(c.looks).some((l) => l.on));
  const added: Cue[] = [];
  if (!pool.length) {
    const blank = makeCue('Auto', {});
    added.push(blank);
    pool = [blank];
  }
  const ranked = [...pool].sort((x, y) => cueEnergy(x) - cueEnergy(y));
  const barLen = (60 / a.bpm) * (show.music?.beatsPerBar ?? 4);
  const cues: TimelineCue[] = [];
  let lastId = '';
  for (let bar = 0; bar < a.barEnergy.length; bar += opts.barsPerCue) {
    const slice = a.barEnergy.slice(bar, bar + opts.barsPerCue);
    const energy = slice.reduce((s, v) => s + v, 0) / slice.length;
    let idx = Math.min(ranked.length - 1, Math.floor(energy * ranked.length));
    // Avoid repeating the same cue back-to-back when there's a choice.
    if (ranked[idx].id === lastId && ranked.length > 1) idx = idx > 0 ? idx - 1 : idx + 1;
    lastId = ranked[idx].id;
    cues.push({ id: uid('tc'), time: Math.max(0, a.offset + bar * barLen), cueId: lastId });
  }
  const hits: TimelineHit[] = opts.accents
    ? a.accents.map((t) => ({ id: uid('hit'), time: t, duration: 0.4, kind: 'flash' as const }))
    : [];
  return { cues, hits, added };
}
