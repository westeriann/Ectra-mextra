import { describe, expect, it } from 'vitest';
import { analyze, autoProgram, computePeaks, cueEnergy } from '../src/core/analysis';
import { buildUniverses } from '../src/core/dmx';
import { computeBeams, DEFAULT_EFFECT, type EffectContext } from '../src/core/effects';
import { BeatClock, evaluate, goCue, initialLive, snapToGrid, timelineAt, type Clock } from '../src/core/engine';
import { builtinShapes, parseIlda, writeIlda } from '../src/core/ilda';
import { effect, newShow, parseShow, serializeShow } from '../src/core/show';
import { STAGE_TEMPLATES } from '../src/core/stages';
import { EFFECT_KINDS } from '../src/core/types';

const clock = (over: Partial<Clock> = {}): Clock => ({ wall: 0, time: 0, beat: 0, songTime: null, level: 0, ...over });

function ctx(over: Partial<EffectContext> = {}): EffectContext {
  const show = newShow('empty');
  return { time: 0, beat: 0, index: 0, count: 1, fixture: show.fixtures[0], level: 0, shapes: builtinShapes(), ...over };
}

describe('effects', () => {
  it('every effect kind produces finite beams', () => {
    for (const kind of EFFECT_KINDS) {
      for (const beat of [0, 0.37, 1.5, 9.9]) {
        const beams = computeBeams(effect({ kind, shapeId: 'builtin_star' }), ctx({ beat, time: beat / 2 }));
        expect(beams.length, kind).toBeGreaterThan(0);
        for (const b of beams) {
          for (const v of [b.x, b.y, b.r, b.g, b.b, b.a]) expect(Number.isFinite(v), `${kind}`).toBe(true);
        }
      }
    }
  });

  it('static fan spans the spread', () => {
    const beams = computeBeams(effect({ kind: 'static', beams: 5, spread: 40 }), ctx());
    expect(beams.map((b) => b.x)).toEqual([-20, -10, 0, 10, 20]);
  });

  it('beat-synced effects repeat each cycle', () => {
    const e = effect({ kind: 'sweep', speed: 0.5 });
    const a = computeBeams(e, ctx({ beat: 1 }));
    const b = computeBeams(e, ctx({ beat: 3 }));
    expect(a[0].x).toBeCloseTo(b[0].x, 6);
  });

  it('strobe turns beams off part of the time', () => {
    const e = effect({ kind: 'static', strobe: 1 });
    expect(computeBeams(e, ctx({ beat: 0.1 })).length).toBeGreaterThan(0);
    expect(computeBeams(e, ctx({ beat: 0.8 })).length).toBe(0);
  });

  it('mirror flips movement for fixtures on stage right', () => {
    const show = newShow('empty');
    const [left, right] = show.fixtures;
    const e = effect({ kind: 'sweep', beams: 1, speed: 0.25, size: 20, mirror: true });
    const l = computeBeams(e, ctx({ fixture: left, beat: 1 }))[0].x;
    const r = computeBeams(e, ctx({ fixture: right, beat: 1 }))[0].x;
    expect(l).toBeCloseTo(-r, 6);
  });

  it('respects the fixture beam limit for regular effects', () => {
    const show = newShow('empty');
    const f = { ...show.fixtures[0], maxBeams: 4 };
    expect(computeBeams(effect({ kind: 'fan', beams: 20 }), ctx({ fixture: f })).length).toBe(4);
  });

  it('audio react scales intensity with level', () => {
    const e = effect({ kind: 'static', beams: 1, audioReact: 1 });
    const quiet = computeBeams(e, ctx({ level: 0 }))[0]?.a ?? 0;
    const loud = computeBeams(e, ctx({ level: 0.6 }))[0].a;
    expect(loud).toBeGreaterThan(quiet);
  });
});

describe('engine', () => {
  it('starts dark and shows beams after GO', () => {
    const show = newShow('club');
    let live = initialLive();
    expect(evaluate(show, live, clock()).fixtures.every((f) => f.beams.length === 0)).toBe(true);
    live = goCue(live, show.cues[0], 0);
    const frame = evaluate(show, live, clock({ wall: 5 }));
    expect(frame.activeCueId).toBe(show.cues[0].id);
    expect(frame.fixtures.some((f) => f.beams.length > 0)).toBe(true);
  });

  it('crossfades between cues', () => {
    const show = newShow('club');
    const a = { ...show.cues[0], fade: 0 };
    const b = { ...show.cues[6], fade: 2 };
    show.cues = [a, b];
    let live = goCue(initialLive(), a, 0);
    live = goCue(live, b, 10);
    const mid = evaluate(show, live, clock({ wall: 11 }));
    const done = evaluate(show, live, clock({ wall: 13 }));
    const greens = (f: typeof mid) => f.fixtures.flatMap((x) => x.beams).filter((bm) => bm.r < 0.1 && bm.g > 0.9).length;
    expect(greens(mid)).toBeGreaterThan(0);
    expect(greens(done)).toBe(0);
  });

  it('timeline picks the cue at the song position', () => {
    const show = newShow('club');
    show.timeline.cues = [
      { id: 't1', time: 0, cueId: show.cues[0].id },
      { id: 't2', time: 10, cueId: show.cues[1].id },
    ];
    expect(timelineAt(show.timeline.cues, 5).current?.id).toBe('t1');
    expect(timelineAt(show.timeline.cues, 12).current?.id).toBe('t2');
    expect(timelineAt(show.timeline.cues, 12).previous?.id).toBe('t1');
    const f = evaluate(show, initialLive(), clock({ songTime: 15, time: 15 }));
    expect(f.activeCueId).toBe(show.cues[1].id);
  });

  it('blackout hits zero the output, flash hits add beams', () => {
    const show = newShow('club');
    show.timeline.cues = [{ id: 't1', time: 0, cueId: show.cues[0].id }];
    show.timeline.hits = [
      { id: 'h1', time: 2, duration: 1, kind: 'blackout' },
      { id: 'h2', time: 5, duration: 1, kind: 'flash' },
    ];
    const live = initialLive();
    expect(evaluate(show, live, clock({ songTime: 2.5 })).fixtures.every((f) => f.beams.length === 0)).toBe(true);
    const normal = evaluate(show, live, clock({ songTime: 4 })).fixtures[0].beams.length;
    const flashed = evaluate(show, live, clock({ songTime: 5.1 }));
    expect(flashed.flash).toBeGreaterThan(0.5);
    expect(flashed.fixtures[0].beams.length).toBeGreaterThan(normal);
  });

  it('programmer overrides the running cue only on edited fixtures', () => {
    const show = newShow('club');
    const live = { ...goCue(initialLive(), show.cues[0], 0), programmer: { [show.fixtures[0].id]: { on: true, effect: effect({ kind: 'static', beams: 1, color: '#ff0000' }) } } };
    const f = evaluate(show, live, clock({ wall: 5 }));
    expect(f.fixtures[0].beams).toHaveLength(1);
    expect(f.fixtures[0].beams[0].r).toBe(1);
    expect(f.fixtures[1].beams[0].g).toBe(1);
  });

  it('flash pads layer a cue on top', () => {
    const show = newShow('club');
    const base = evaluate(show, initialLive(), clock()).fixtures[0].beams.length;
    const live = { ...initialLive(), activePads: [show.pads[0].id] };
    expect(evaluate(show, live, clock()).fixtures[0].beams.length).toBeGreaterThan(base);
  });

  it('tap tempo converges on the tapped BPM', () => {
    const c = new BeatClock(100);
    let bpm: number | null = null;
    for (let i = 0; i < 6; i++) bpm = c.tap(i * 0.5);
    expect(bpm).toBe(120);
  });

  it('snaps times to the beat grid', () => {
    expect(snapToGrid(1.02, 120, 0)).toBeCloseTo(1, 6);
    expect(snapToGrid(1.13, 120, 0, 4)).toBeCloseTo(1.125, 6);
  });
});

describe('show files', () => {
  it('round-trips every stage template', () => {
    for (const t of STAGE_TEMPLATES) {
      const show = newShow(t.id);
      expect(parseShow(serializeShow(show))).toEqual(show);
    }
  });

  it('fills in missing fields from older files', () => {
    const show = newShow('club');
    const raw = JSON.parse(serializeShow(show));
    delete raw.output;
    delete raw.pads;
    delete raw.cues[0].looks[show.fixtures[0].id].effect.audioReact;
    const parsed = parseShow(JSON.stringify(raw));
    expect(parsed.output.artnet.rate).toBe(40);
    expect(parsed.pads).toEqual([]);
    expect(parsed.cues[0].looks[show.fixtures[0].id].effect.audioReact).toBe(DEFAULT_EFFECT.audioReact);
  });

  it('rejects files that are not shows', () => {
    expect(() => parseShow('{"hello":1}')).toThrow(/not a Laser Studio show/);
  });
});

describe('ILDA', () => {
  it('round-trips a true-colour shape', () => {
    const star = builtinShapes().find((s) => s.name === 'Star')!;
    const back = parseIlda(writeIlda(star));
    expect(back.frames).toHaveLength(1);
    expect(back.frames[0]).toHaveLength(star.frames[0].length);
    back.frames[0].forEach((p, i) => {
      const o = star.frames[0][i];
      expect(p.x).toBeCloseTo(o.x, 3);
      expect(p.y).toBeCloseTo(o.y, 3);
      expect(p.blank).toBe(o.blank);
      expect(p.g).toBeCloseTo(o.g, 2);
    });
  });

  it('reads indexed format 1', () => {
    const buf = new ArrayBuffer(32 + 6 * 2 + 32);
    const v = new DataView(buf);
    const hdr = (at: number, count: number) => {
      'ILDA'.split('').forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
      v.setUint8(at + 7, 1);
      v.setUint16(at + 24, count);
    };
    hdr(0, 2);
    v.setInt16(32, 16384);
    v.setInt16(34, -16384);
    v.setUint8(36, 0x40);
    v.setInt16(38, 0);
    v.setInt16(40, 32767);
    hdr(44, 0);
    const s = parseIlda(buf);
    expect(s.frames[0][0]).toMatchObject({ x: 0.5, y: -0.5, blank: true });
    expect(s.frames[0][1].blank).toBe(false);
  });

  it('rejects junk', () => {
    expect(() => parseIlda(new ArrayBuffer(64))).toThrow();
  });
});

describe('music analysis', () => {
  function clickTrack(bpm: number, seconds: number, offset: number, sr = 22050): Float32Array {
    const s = new Float32Array(Math.floor(seconds * sr));
    const period = 60 / bpm;
    for (let t = offset; t < seconds; t += period) {
      const start = Math.floor(t * sr);
      for (let i = 0; i < 1500 && start + i < s.length; i++) s[start + i] += Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp(-i / 300);
    }
    return s;
  }

  it('detects tempo and first beat of a click track', () => {
    for (const bpm of [100, 128, 140]) {
      const a = analyze(clickTrack(bpm, 30, 0.25), 22050);
      expect(Math.abs(a.bpm - bpm), `bpm ${bpm} got ${a.bpm}`).toBeLessThan(0.6);
      const period = 60 / bpm;
      const phaseErr = Math.abs(((a.offset - 0.25 + period / 2) % period) - period / 2);
      expect(phaseErr, `offset for ${bpm}`).toBeLessThan(0.03);
    }
  });

  it('waveform peaks are bounded', () => {
    const p = computePeaks(clickTrack(120, 4, 0), 100);
    expect(p).toHaveLength(200);
    for (const v of p) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('auto-program places calm cues in quiet bars and intense cues in loud bars', () => {
    const show = newShow('club');
    const a = { bpm: 120, offset: 0, duration: 64, peaks: new Float32Array(), barEnergy: [0.05, 0.05, 0.05, 0.05, 1, 1, 1, 1], accents: [8] };
    const res = autoProgram(show, a, { barsPerCue: 4, accents: true });
    expect(res.cues).toHaveLength(2);
    expect(res.cues[1].time).toBe(8);
    expect(res.hits).toHaveLength(1);
    const quiet = show.cues.find((c) => c.id === res.cues[0].cueId)!;
    const loud = show.cues.find((c) => c.id === res.cues[1].cueId)!;
    expect(cueEnergy(loud)).toBeGreaterThan(cueEnergy(quiet));
  });
});

describe('DMX', () => {
  it('patches fixtures at their addresses', () => {
    const show = newShow('club');
    const live = goCue(initialLive(), show.cues[0], 0);
    const frame = evaluate(show, live, clock({ wall: 5 }));
    const u = buildUniverses(show, frame.fixtures, frame.looks).get(0)!;
    for (const f of show.fixtures) {
      const a = f.dmx.address - 1;
      expect(u[a]).toBeGreaterThan(0); // dimmer
      expect(u[a + 7]).toBe(255); // green, from the green fan cue
    }
  });
});

describe('laser path', () => {
  it('dwells on each beam with blanked moves between', async () => {
    const { beamsToPoints } = await import('../src/core/laserpath');
    const pts = beamsToPoints(
      [
        { x: 20, y: 0, r: 1, g: 0, b: 0, a: 1 },
        { x: -20, y: 0, r: 0, g: 1, b: 0, a: 0.5 },
      ],
      80,
      { dwell: 3, blanks: 2 },
    );
    expect(pts.length).toBe((2 + 3) * 2 * 5);
    // First beam visited is the left one (x = -0.5), dimmed to half.
    expect(pts.slice(10, 15)).toEqual([-0.5, 0, 0, 0.5, 0]);
    // Travel points are blanked.
    expect(pts.slice(25, 30).slice(2)).toEqual([0, 0, 0]);
    expect(beamsToPoints([], 60)).toEqual([0, 0, 0, 0, 0]);
  });
});
