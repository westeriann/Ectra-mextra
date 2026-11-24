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

  it('dissolves between cues', () => {
    const show = newShow('club');
    const a = { ...show.cues[0], fade: 0 };
    const b = { ...show.cues[6], fade: 2, transition: 'dissolve' as const };
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

describe('transitions and automation in the engine', () => {
  it('morphs beams from one look into the next', () => {
    const show = newShow('club');
    const fx = show.fixtures[0];
    const look = (spread: number, color: string) => ({ [fx.id]: { on: true, effect: effect({ kind: 'static', beams: 3, spread, color, mirror: false }) } });
    const a = { ...show.cues[0], id: 'A', fade: 0, looks: look(20, '#ff0000') };
    const b = { ...show.cues[1], id: 'B', fade: 2, transition: 'morph' as const, looks: look(60, '#0000ff') };
    show.cues = [a, b];
    let live = goCue(initialLive(), a, 0);
    live = goCue(live, b, 10);
    const mid = evaluate(show, live, clock({ wall: 11 })).fixtures[0].beams;
    expect(mid).toHaveLength(3);
    // Halfway: beams sit between the two fans and the colour is half red, half blue.
    expect(mid[0].x).toBeCloseTo(-20, 6);
    expect(mid[2].x).toBeCloseTo(20, 6);
    expect(mid[0].r).toBeCloseTo(0.5, 6);
    expect(mid[0].b).toBeCloseTo(0.5, 6);
    expect(evaluate(show, live, clock({ wall: 12.5 })).fixtures[0].beams[2].x).toBeCloseTo(30, 6);
  });

  it('applies automation lanes at the song position', () => {
    const show = newShow('club');
    show.timeline.cues = [{ id: 't1', time: 0, cueId: show.cues[0].id }];
    show.timeline.lanes = [
      { id: 'l1', param: 'intensity', target: 'all', enabled: true, points: [{ id: 'p1', time: 0, value: 0, curve: 'linear' }, { id: 'p2', time: 10, value: 1, curve: 'linear' }] },
      { id: 'l2', param: 'tilt', target: 'Bar', enabled: true, points: [{ id: 'p3', time: 0, value: 10, curve: 'hold' }] },
    ];
    const at = (t: number) => evaluate(show, initialLive(), clock({ songTime: t, time: t })).fixtures[0].beams;
    expect(at(2.5)[0].a).toBeCloseTo(0.25, 6);
    expect(at(10)[0].a).toBeCloseTo(1, 6);
    expect(at(5)[0].y).toBeCloseTo(10, 6);
    show.timeline.lanes[1].target = 'Somewhere else';
    expect(at(5)[0].y).toBeCloseTo(0, 6);
  });
});

describe('automation', () => {
  const lane = (points: [number, number, ('linear' | 'smooth' | 'hold')?][], param: 'speed' | 'intensity' = 'speed') => ({
    id: 'l', param, target: 'all', enabled: true,
    points: points.map(([time, value, curve], i) => ({ id: `p${i}`, time, value, curve: curve ?? ('linear' as const) })),
  });

  it('interpolates linear, smooth and hold segments and holds the ends', async () => {
    const { laneValue } = await import('../src/core/automation');
    const l = lane([[0, 0], [10, 1, 'smooth'], [20, 3, 'hold'], [30, 0]]);
    expect(laneValue(l, -5)).toBe(0);
    expect(laneValue(l, 5)).toBeCloseTo(0.5);
    expect(laneValue(l, 12.5)).toBeCloseTo(1 + 2 * 0.15625);
    expect(laneValue(l, 15)).toBeCloseTo(2);
    expect(laneValue(l, 25)).toBe(3);
    expect(laneValue(l, 99)).toBe(0);
  });

  it('integrates speed curves exactly so phase never jumps', async () => {
    const { integrateProduct } = await import('../src/core/automation');
    const ramp = lane([[0, 1], [10, 3]]);
    expect(integrateProduct([ramp], 0, 10)).toBeCloseTo(20, 9);
    expect(integrateProduct([ramp], 0, 20)).toBeCloseTo(50, 9);
    expect(integrateProduct([ramp, lane([[0, 2]])], 0, 10)).toBeCloseTo(40, 9);
    const hold = lane([[0, 1, 'hold'], [5, 4]]);
    expect(integrateProduct([hold], 0, 6)).toBeCloseTo(9, 6);
    // Continuity: tiny step in time -> tiny step in integral.
    const a = integrateProduct([ramp], 0, 4.999999);
    const b = integrateProduct([ramp], 0, 5.000001);
    expect(b - a).toBeLessThan(1e-4);
  });

  it('shifts hue', async () => {
    const { shiftHue } = await import('../src/core/automation');
    const g = shiftHue({ x: 0, y: 0, r: 1, g: 0, b: 0, a: 1 }, 1 / 3);
    expect(g.g).toBeCloseTo(1);
    expect(g.r).toBeCloseTo(0);
  });

  it('morph keeps total brightness at the ends when beam counts differ', async () => {
    const { morphBeams } = await import('../src/core/automation');
    const A = [{ x: 0, y: 0, r: 1, g: 1, b: 1, a: 1 }];
    const B = Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0, r: 1, g: 1, b: 1, a: 1 }));
    const near0 = morphBeams(A, B, 1e-9).reduce((s, x) => s + x.a, 0);
    expect(near0).toBeCloseTo(1, 6);
    expect(morphBeams(A, B, 0.5)).toHaveLength(4);
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

describe('beam tracing', () => {
  const stageWith = async (els: Parameters<typeof import('../src/core/stages').makeElement>[]) => {
    const { makeElement } = await import('../src/core/stages');
    return { name: 't', haze: 0.5, ambient: 0, sky: '#000', elements: [makeElement('floor', [0, 0, 0]), ...els.map((a) => makeElement(...a))] };
  };
  const opts = (segments = 1000) => ({ maxLength: 100, maxDepth: 3, ballSplits: 6, time: 0, budget: { segments } });

  it('stops beams at solid objects, and not when occlusion is off', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    const stage = await stageWith([['wall', [0, 0, 10], { size: [10, 10, 1] }]]);
    const segs = traceBeam(buildTraceScene(stage), [0, 5, 0], [0, 0, 1], opts());
    expect(segs).toHaveLength(1);
    expect(segs[0].length).toBeCloseTo(9.5, 6);
    expect(segs[0].hit?.normal).toEqual([0, 0, -1]);
    const open = traceBeam(buildTraceScene({ ...stage, occlusion: false }), [0, 5, 0], [0, 0, 1], opts());
    expect(open[0].length).toBe(100);
  });

  it('handles rotated boxes and ignores boxes the laser sits inside', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    // A thin wall rotated 90° so it runs along z — a beam along +x hits its face at x = 5 - 0.5.
    const stage = await stageWith([['wall', [5, 0, 0], { size: [10, 10, 1], rotation: 90 }], ['platform', [0, 0, 0], { size: [4, 8, 4] }]]);
    const segs = traceBeam(buildTraceScene(stage), [0, 5, 0], [1, 0, 0], opts());
    expect(segs[0].length).toBeCloseTo(4.5, 6);
    expect(segs[0].hit!.normal[0]).toBeCloseTo(-1, 6);
  });

  it('lands on the floor', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    const segs = traceBeam(buildTraceScene(await stageWith([])), [0, 10.1, 0], [0, -Math.SQRT1_2, Math.SQRT1_2], opts());
    expect(segs[0].length).toBeCloseTo(10 * Math.SQRT2, 6);
    expect(segs[0].hit?.kind).toBe('floor');
  });

  it('reflects off mirrors (both faces) and respects their size', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    // Mirror facing -z... rotated 45° so a beam along +z turns to +x or -x.
    const stage = await stageWith([['mirror', [0, 4, 10], { size: [4, 2, 0.05], rotation: 45 }]]);
    const scene = buildTraceScene(stage);
    const segs = traceBeam(scene, [0, 5, 0], [0, 0, 1], opts());
    expect(segs).toHaveLength(2);
    expect(segs[0].length).toBeCloseTo(10, 6);
    expect(Math.abs(segs[1].dir[0])).toBeCloseTo(1, 6);
    expect(segs[1].dir[2]).toBeCloseTo(0, 6);
    expect(segs[1].gain).toBeLessThan(1);
    // Above the mirror: passes straight by.
    expect(traceBeam(scene, [0, 7, 0], [0, 0, 1], opts())).toHaveLength(1);
  });

  it('tilted mirrors send beams up', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    const stage = await stageWith([['mirror', [0, 4, 10], { size: [4, 4, 0.05], rotation: 180, tilt: 30 }]]);
    const segs = traceBeam(buildTraceScene(stage), [0, 6, 0], [0, 0, 1], opts());
    expect(segs[1].dir[1]).toBeGreaterThan(0.5);
    expect(segs[1].dir[2]).toBeLessThan(0);
  });

  it('mirror balls split beams and stay within the budget', async () => {
    const { buildTraceScene, traceBeam } = await import('../src/core/trace');
    const stage = await stageWith([['mirrorball', [0, 4.5, 10], { size: [1, 1, 1] }]]);
    const scene = buildTraceScene(stage);
    const segs = traceBeam(scene, [0, 5, 0], [0, 0, 1], { ...opts(), maxDepth: 1 });
    expect(segs).toHaveLength(1 + 6);
    expect(segs[0].length).toBeCloseTo(9.5, 6);
    // Reflections leave the ball (point outwards from its surface).
    for (const s of segs.slice(1)) expect(s.dir[2]).toBeLessThan(0.99);
    const limited = traceBeam(scene, [0, 5, 0], [0, 0, 1], { ...opts(3), maxDepth: 1 });
    expect(limited).toHaveLength(3);
  });
});
