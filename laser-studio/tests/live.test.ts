import { describe, expect, it } from 'vitest';
import { LiveAnalyzer } from '../src/core/live';

const FS = 48000;

/** Drum machine: kicks, snares and hats at beat positions, rendered to mono PCM. */
function drums(bpm: number, seconds: number, pattern: { kick: number[]; snare: number[]; hat: number[] }, gain = 1, seed = 1): Float32Array {
  const out = new Float32Array(Math.floor(seconds * FS));
  let rnd = seed;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const beat = 60 / bpm;
  const add = (t: number, fn: (i: number) => number, len: number) => {
    const s = Math.floor(t * FS);
    for (let i = 0; i < len && s + i < out.length; i++) out[s + i] += fn(i) * gain;
  };
  for (let bar = 0; bar * 4 * beat < seconds; bar++) {
    const t0 = bar * 4 * beat;
    for (const b of pattern.kick) add(t0 + b * beat, (i) => 0.9 * Math.sin((2 * Math.PI * (50 + 80 * Math.exp(-i / 1500)) * i) / FS) * Math.exp(-i / 6000), 12000);
    for (const b of pattern.snare) add(t0 + b * beat, (i) => (0.35 * noise() + 0.25 * Math.sin((2 * Math.PI * 200 * i) / FS)) * Math.exp(-i / 4000), 9000);
    for (const b of pattern.hat) add(t0 + b * beat, (i) => 0.12 * noise() * Math.exp(-i / 500), 2500);
  }
  return out;
}

/** Feed in 1024-sample blocks as if arriving in real time; returns the analyzer and per-block feature samples. */
function play(pcm: Float32Array, a = new LiveAnalyzer(FS)) {
  const block = 1024;
  const kicksAt: number[] = [];
  let lastKick = 0;
  for (let i = 0; i + block <= pcm.length; i += block) {
    const now = (i + block) / FS;
    a.feed(pcm.subarray(i, i + block), now);
    a.update(now);
    if (a.hits.kick !== lastKick) {
      lastKick = a.hits.kick;
      kicksAt.push(now);
    }
  }
  return { a, end: pcm.length / FS, kicksAt };
}

const HOUSE = { kick: [0, 1, 2, 3], snare: [1, 3], hat: [0.5, 1.5, 2.5, 3.5] };
const DNB = { kick: [0, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] };

describe('live audio analysis (ported from Amethyst)', () => {
  it('locks onto 128 BPM house and puts beats on the kicks', () => {
    const { a, end } = play(drums(128, 20, HOUSE));
    expect(a.locked).toBe(true);
    expect(Math.abs(a.bpm - 128)).toBeLessThan(1);
    // Kicks are at whole beats: the beat clock's phase should sit near an integer at a kick.
    const lastKick = Math.floor(end / (60 / 128)) * (60 / 128);
    const phase = a.beatAt(lastKick);
    expect(Math.abs(phase - Math.round(phase))).toBeLessThan(0.12);
  });

  it('holds 174 for drum & bass instead of halving to 87', () => {
    const { a } = play(drums(174, 20, DNB));
    expect(Math.abs(a.bpm - 174)).toBeLessThan(1.5);
  });

  it('detects kicks, snares and hats', () => {
    const { a, end } = play(drums(120, 12, HOUSE));
    const beats = end / 0.5;
    expect(a.hits.kick).toBeGreaterThan(beats * 0.7);
    expect(a.hits.kick).toBeLessThan(beats * 1.2);
    expect(a.hits.snare).toBeGreaterThan(beats * 0.5 * 0.6); // snares on 2 and 4
    expect(a.hits.hat).toBeGreaterThan(beats * 0.6);
  });

  it('auto-levels: a quiet and a loud input give similar bands', () => {
    const quiet = play(drums(128, 6, HOUSE, 0.05));
    const loud = play(drums(128, 6, HOUSE, 1));
    const fq = quiet.a.features(quiet.end);
    const fl = loud.a.features(loud.end);
    expect(fq.active).toBe(true);
    expect(Math.abs(fq.bass - fl.bass)).toBeLessThan(0.25);
    expect(quiet.a.hits.kick).toBeGreaterThan(loud.a.hits.kick * 0.7);
  });

  it('goes quiet when the input stops, and tap tempo sets the clock', () => {
    const { a, end } = play(drums(128, 4, HOUSE));
    const f = a.features(end + 2);
    expect(f.active).toBe(false);
    expect(f.kick).toBeLessThan(0.01);
    for (let i = 0; i < 4; i++) a.tap(100 + i * 0.5);
    expect(a.bpm).toBeCloseTo(120, 6);
    expect(a.beatAt(101.5) % 1).toBeCloseTo(0, 6);
  });
});

describe('audio reactions in the engine', () => {
  it('kick pump brightens on hits, flash adds beams, nothing happens without sound', async () => {
    const { newShow } = await import('../src/core/show');
    const { evaluate, goCue, initialLive } = await import('../src/core/engine');
    const { routeFromPreset } = await import('../src/core/react');
    const show = newShow('club');
    show.audio.routes = [routeFromPreset('kick-pump')!, routeFromPreset('bass-breathe')!];
    const live = goCue(initialLive(), show.cues[0], 0);
    const base = { level: 0.5, bass: 0, mid: 0, treble: 0, kick: 0, snare: 0, hat: 0, beat: 0, active: true };
    const at = (audio: typeof base) => evaluate(show, live, { wall: 5, time: 5, beat: 0, songTime: null, level: 0, audio }).fixtures[0].beams;
    const quiet = at(base)[0].a;
    const hit = at({ ...base, kick: 1 })[0].a;
    expect(hit).toBeGreaterThan(quiet * 2);
    // Bass makes looks bigger (fan movement amount scales).
    const off = evaluate(show, live, { wall: 5, time: 5.3, beat: 0.6, songTime: null, level: 0, audio: { ...base, active: false } }).fixtures[0].beams;
    const big = evaluate(show, live, { wall: 5, time: 5.3, beat: 0.6, songTime: null, level: 0, audio: { ...base, bass: 1 } }).fixtures[0].beams;
    expect(Math.abs(big[0].x - off[0].x)).toBeGreaterThan(1);
    // Flash route.
    show.audio.routes = [routeFromPreset('kick-flash')!];
    expect(at({ ...base, kick: 1 }).length).toBeGreaterThan(at(base).length);
  });
});
