// The playback engine: works out which cue(s) are on stage right now and turns
// them into beams. It is a pure function of (show, live state, clock) so the
// editor and the fullscreen output window always render the same frame.

import { easeInOut, integrateProduct, isNeutral, modifiersAt, morphBeams, NEUTRAL, shiftHue, type Modifiers } from './automation';
import { computeBeams, type EffectContext } from './effects';
import type { Beam, Cue, Fixture, FixtureFrame, FixtureLook, Show, TimelineCue, TimelineHit } from './types';
import { clamp, fract } from './util';

export interface LiveState {
  /** Cue running in live (non-timeline) mode. */
  cueId: string | null;
  prevCueId: string | null;
  /** Wall-clock second the current live crossfade started. */
  fadeStart: number;
  fadeDuration: number;
  /** Unsaved edits being previewed; overrides cues for the fixtures it contains. */
  programmer: Record<string, FixtureLook> | null;
  /** Pads currently held (flash) or latched (toggle). */
  activePads: string[];
  master: number;
  blackout: boolean;
  /** When music plays, let the timeline choose cues. */
  timelineControl: boolean;
}

export function initialLive(): LiveState {
  return {
    cueId: null,
    prevCueId: null,
    fadeStart: 0,
    fadeDuration: 0,
    programmer: null,
    activePads: [],
    master: 1,
    blackout: false,
    timelineControl: true,
  };
}

export interface Clock {
  /** Monotonic wall-clock seconds — drives manual crossfades. */
  wall: number;
  /** Effect time in seconds: song position while music plays, wall time otherwise. */
  time: number;
  beat: number;
  /** Song position, or null when no song is playing/paused. */
  songTime: number | null;
  /** Audio level 0..1. */
  level: number;
  /** True when time/beat come from the playing song (enables speed automation). */
  songClock?: boolean;
}

export interface Frame {
  fixtures: FixtureFrame[];
  /** 0..1 white flash from timeline hits (also lights the screens). */
  flash: number;
  /** Final master after blackout/strobe hits. */
  master: number;
  activeCueId: string | null;
  /** The dominant look on each fixture (used for DMX output). */
  looks: Record<string, FixtureLook>;
  beat: number;
  level: number;
}

/** Go to a cue in live mode with its crossfade. */
export function goCue(live: LiveState, cue: Cue | null, wall: number): LiveState {
  return {
    ...live,
    prevCueId: live.cueId,
    cueId: cue?.id ?? null,
    fadeStart: wall,
    fadeDuration: cue?.fade ?? 0,
  };
}

/** Next cue in the list after the current one (wraps to the first). */
export function nextCue(show: Show, live: LiveState): Cue | null {
  if (!show.cues.length) return null;
  const i = show.cues.findIndex((c) => c.id === live.cueId);
  return show.cues[(i + 1) % show.cues.length];
}

export function prevCue(show: Show, live: LiveState): Cue | null {
  if (!show.cues.length) return null;
  const i = show.cues.findIndex((c) => c.id === live.cueId);
  return show.cues[i <= 0 ? show.cues.length - 1 : i - 1];
}

/** The timeline entry in charge at `t`, plus the one before it (for the crossfade). */
export function timelineAt(entries: TimelineCue[], t: number): { current: TimelineCue | null; previous: TimelineCue | null } {
  let current: TimelineCue | null = null;
  let previous: TimelineCue | null = null;
  for (const e of entries) {
    if (e.time > t) continue;
    if (!current || e.time >= current.time) {
      previous = current;
      current = e;
    } else if (!previous || e.time > previous.time) {
      previous = e;
    }
  }
  return { current, previous };
}

export function hitsAt(hits: TimelineHit[], t: number): TimelineHit[] {
  return hits.filter((h) => t >= h.time && t < h.time + Math.max(h.duration, 0.05));
}

/** A crossfade between two cues (either may be missing). */
interface Fade {
  prev: Cue | null;
  cur: Cue | null;
  /** 0 = all prev, 1 = all cur. */
  t: number;
  morph: boolean;
}

export function evaluate(show: Show, live: LiveState, clock: Clock): Frame {
  const byId = new Map(show.cues.map((c) => [c.id, c]));
  let fade: Fade = { prev: null, cur: null, t: 1, morph: false };

  const useTimeline = live.timelineControl && clock.songTime !== null && show.timeline.cues.length > 0;
  if (useTimeline) {
    const { current, previous } = timelineAt(show.timeline.cues, clock.songTime!);
    const cur = current ? byId.get(current.cueId) ?? null : null;
    if (cur && current) {
      const t = cur.fade > 0 ? clamp((clock.songTime! - current.time) / cur.fade, 0, 1) : 1;
      const prev = previous ? byId.get(previous.cueId) ?? null : null;
      fade = { prev: prev && prev.id !== cur.id ? prev : null, cur, t, morph: cur.transition !== 'dissolve' };
    }
  } else {
    const cur = live.cueId ? byId.get(live.cueId) ?? null : null;
    const t = live.fadeDuration > 0 ? clamp((clock.wall - live.fadeStart) / live.fadeDuration, 0, 1) : 1;
    const prev = live.prevCueId ? byId.get(live.prevCueId) ?? null : null;
    fade = { prev: prev && prev.id !== cur?.id ? prev : null, cur, t, morph: (cur?.transition ?? 'morph') !== 'dissolve' };
  }
  if (fade.t >= 1) fade.prev = null;

  // Timeline hits.
  let flash = 0;
  let master = live.blackout ? 0 : live.master;
  if (clock.songTime !== null) {
    for (const h of hitsAt(show.timeline.hits, clock.songTime)) {
      const age = clock.songTime - h.time;
      if (h.kind === 'flash') flash = Math.max(flash, clamp(1 - age / Math.max(h.duration, 0.05), 0, 1));
      else if (h.kind === 'blackout') master = 0;
      else if (h.kind === 'strobe' && fract(clock.beat * 4) > 0.4) master = 0;
    }
  }

  const auto = automationFor(show, clock);
  const frames: FixtureFrame[] = show.fixtures.map((f) => ({ fixtureId: f.id, beams: [] }));
  const looksOut: Record<string, FixtureLook> = {};
  const programmer = live.programmer;
  const order = (looks: Record<string, FixtureLook>) => {
    // Position of each fixture among those lit by a look (for phase spread).
    const ids = show.fixtures.filter((f) => looks[f.id]?.on).map((f) => f.id);
    return { pos: new Map(ids.map((id, k) => [id, k])), count: ids.length };
  };
  const prevOrder = fade.prev ? order(fade.prev.looks) : null;
  const curOrder = fade.cur ? order(fade.cur.looks) : null;
  const progOrder = programmer ? order(programmer) : null;
  const ease = fade.morph ? easeInOut(fade.t) : fade.t;

  show.fixtures.forEach((f, fi) => {
    const mods = auto(f);
    const run = (look: FixtureLook, o: { pos: Map<string, number>; count: number }) => beamsFor(show, f, look, o.pos.get(f.id) ?? 0, o.count, clock, mods);
    const out = frames[fi];
    if (programmer?.[f.id]) {
      // The programmer replaces whatever the cues put on this fixture.
      looksOut[f.id] = programmer[f.id];
      if (programmer[f.id].on) out.beams = run(programmer[f.id], progOrder!);
    } else {
      const a = fade.prev?.looks[f.id]?.on ? fade.prev.looks[f.id] : null;
      const b = fade.cur?.looks[f.id]?.on ? fade.cur.looks[f.id] : null;
      const A = a ? run(a, prevOrder!) : [];
      const B = b ? run(b, curOrder!) : [];
      if (!a) out.beams = B.map((x) => scale(x, fade.t));
      else if (!b) out.beams = A.map((x) => scale(x, 1 - fade.t));
      else if (fade.morph) out.beams = morphBeams(A, B, ease);
      else out.beams = [...A.map((x) => scale(x, 1 - fade.t)), ...B.map((x) => scale(x, fade.t))];
      const dominant = b && (fade.t >= 0.5 || !a) ? b : a ?? b;
      if (dominant) looksOut[f.id] = dominant;
    }
    // Flash pads add their cue on top.
    for (const padId of live.activePads) {
      const pad = show.pads.find((p) => p.id === padId);
      const cue = pad?.cueId ? byId.get(pad.cueId) : undefined;
      const look = cue?.looks[f.id];
      if (cue && look?.on) out.beams.push(...run(look, order(cue.looks)));
    }
    if (flash > 0) {
      for (let i = 0; i < 12; i++) out.beams.push({ x: (i / 11 - 0.5) * Math.min(f.scanAngle, 90), y: 0, r: 1, g: 1, b: 1, a: flash * f.power });
    }
    if (master < 1) out.beams = out.beams.map((x) => scale(x, master));
    out.beams = out.beams.filter((x) => x.a > 0.003);
  });

  return { fixtures: frames, flash: flash * master, master, activeCueId: fade.cur?.id ?? null, looks: looksOut, beat: clock.beat, level: clock.level };
}

/**
 * Returns a function giving each fixture its automation modifiers at the
 * current song position (cached per group).
 */
function automationFor(show: Show, clock: Clock): (f: Fixture) => Modifiers {
  const lanes = show.timeline.lanes;
  if (clock.songTime === null || !lanes.some((l) => l.enabled && l.points.length)) return () => NEUTRAL;
  const cache = new Map<string, Modifiers>();
  return (f) => {
    let m = cache.get(f.group);
    if (!m) {
      m = modifiersAt(lanes, f.group, clock.songTime!);
      cache.set(f.group, m);
    }
    return m;
  };
}

function beamsFor(show: Show, fixture: Fixture, look: FixtureLook, index: number, count: number, clock: Clock, mods: Modifiers = NEUTRAL): Beam[] {
  let time = clock.time;
  let beat = clock.beat;
  let e = look.effect;
  if (!isNeutral(mods)) {
    e = {
      ...e,
      intensity: e.intensity * mods.intensity,
      size: e.size * mods.size,
      spread: e.spread * mods.spread,
      pan: e.pan + mods.pan,
      tilt: e.tilt + mods.tilt,
    };
    // Speed automation: integrate the speed curve so movement never jumps.
    if (mods.speedLanes.length && clock.songClock && clock.songTime !== null) {
      time = integrateProduct(mods.speedLanes, 0, clock.songTime);
      const m = show.music;
      if (m) beat = (integrateProduct(mods.speedLanes, m.offset, clock.songTime) * m.bpm) / 60;
    }
  }
  const ctx: EffectContext = { time, beat, index, count, fixture, level: clock.level, shapes: show.shapes };
  const half = fixture.scanAngle / 2;
  // Projectors can't steer past their scan field; clip beams that would.
  let beams = computeBeams(e, ctx).filter((b) => Math.abs(b.x - e.pan) <= half + 1e-6);
  if (mods.hue) beams = beams.map((b) => shiftHue(b, mods.hue));
  return beams;
}

const scale = (b: Beam, w: number): Beam => (w === 1 ? b : { ...b, a: b.a * w });

/**
 * Keeps beat position continuous while the tempo changes, and supports tap tempo.
 */
export class BeatClock {
  beat = 0;
  bpm: number;
  private taps: number[] = [];
  constructor(bpm = 128) {
    this.bpm = bpm;
  }
  advance(dt: number) {
    this.beat += (dt * this.bpm) / 60;
  }
  /** Register a tap at wall-clock second `t`. Returns the new BPM once there are enough taps. */
  tap(t: number): number | null {
    if (this.taps.length && t - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 3) return null;
    const gaps = this.taps.slice(1).map((v, i) => v - this.taps[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    this.bpm = Math.round((60 / avg) * 10) / 10;
    // Snap the downbeat to the tap.
    this.beat = Math.round(this.beat);
    return this.bpm;
  }
}

/** Beat position for a song time. */
export function songBeat(t: number, bpm: number, offset: number): number {
  return ((t - offset) * bpm) / 60;
}

/** Snap a time to the nearest beat subdivision of the song grid. */
export function snapToGrid(t: number, bpm: number, offset: number, division = 1): number {
  const step = 60 / bpm / division;
  return Math.max(0, offset + Math.round((t - offset) / step) * step);
}
