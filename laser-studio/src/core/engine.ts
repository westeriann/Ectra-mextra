// The playback engine: works out which cue(s) are on stage right now and turns
// them into beams. It is a pure function of (show, live state, clock) so the
// editor and the fullscreen output window always render the same frame.

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

interface Layer {
  looks: Record<string, FixtureLook>;
  weight: number;
  programmer?: boolean;
}

export function evaluate(show: Show, live: LiveState, clock: Clock): Frame {
  const byId = new Map(show.cues.map((c) => [c.id, c]));
  const layers: Layer[] = [];
  let activeCueId: string | null = null;

  const useTimeline = live.timelineControl && clock.songTime !== null && show.timeline.cues.length > 0;
  if (useTimeline) {
    const { current, previous } = timelineAt(show.timeline.cues, clock.songTime!);
    const cur = current ? byId.get(current.cueId) ?? null : null;
    if (cur && current) {
      activeCueId = cur.id;
      const t = cur.fade > 0 ? clamp((clock.songTime! - current.time) / cur.fade, 0, 1) : 1;
      const prev = previous ? byId.get(previous.cueId) : undefined;
      if (prev && t < 1 && prev.id !== cur.id) layers.push({ looks: prev.looks, weight: 1 - t });
      layers.push({ looks: cur.looks, weight: t });
    }
  } else {
    const cur = live.cueId ? byId.get(live.cueId) ?? null : null;
    activeCueId = cur?.id ?? null;
    const t = live.fadeDuration > 0 ? clamp((clock.wall - live.fadeStart) / live.fadeDuration, 0, 1) : 1;
    const prev = live.prevCueId ? byId.get(live.prevCueId) : undefined;
    if (prev && t < 1 && prev.id !== cur?.id) layers.push({ looks: prev.looks, weight: 1 - t });
    if (cur) layers.push({ looks: cur.looks, weight: t });
  }

  // The programmer replaces the running look for the fixtures being edited.
  const programmed = live.programmer ? new Set(Object.keys(live.programmer)) : null;
  if (live.programmer) layers.push({ looks: live.programmer, weight: 1, programmer: true });

  for (const padId of live.activePads) {
    const pad = show.pads.find((p) => p.id === padId);
    const cue = pad?.cueId ? byId.get(pad.cueId) : undefined;
    if (cue) layers.push({ looks: cue.looks, weight: 1 });
  }

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

  const frames: FixtureFrame[] = show.fixtures.map((f) => ({ fixtureId: f.id, beams: [] }));
  const index = new Map(show.fixtures.map((f, i) => [f.id, i]));
  const looksOut: Record<string, FixtureLook> = {};
  const lookWeight: Record<string, number> = {};

  for (const layer of layers) {
    if (layer.weight <= 0.001) continue;
    const looks = layer.looks;
    const isProgrammer = !!layer.programmer;
    const ids = Object.keys(looks).filter((id) => index.has(id) && looks[id].on);
    ids.forEach((id, k) => {
      const fi = index.get(id)!;
      // Programmer replaces whatever the cues put on this fixture.
      if (isProgrammer) frames[fi].beams = [];
      else if (programmed?.has(id)) return;
      if (isProgrammer || layer.weight > (lookWeight[id] ?? 0)) {
        looksOut[id] = looks[id];
        lookWeight[id] = isProgrammer ? Infinity : layer.weight;
      }
      const beams = beamsFor(show, show.fixtures[fi], looks[id], k, ids.length, clock);
      for (const b of beams) frames[fi].beams.push(scale(b, layer.weight));
    });
  }

  if (flash > 0) {
    show.fixtures.forEach((f, fi) => {
      for (let i = 0; i < 12; i++) {
        frames[fi].beams.push({ x: (i / 11 - 0.5) * Math.min(f.scanAngle, 90), y: 0, r: 1, g: 1, b: 1, a: flash * f.power });
      }
    });
  }

  if (master < 1) for (const fr of frames) fr.beams = fr.beams.map((b) => scale(b, master));
  for (const fr of frames) fr.beams = fr.beams.filter((b) => b.a > 0.003);

  return { fixtures: frames, flash: flash * master, master, activeCueId, looks: looksOut, beat: clock.beat, level: clock.level };
}

function beamsFor(show: Show, fixture: Fixture, look: FixtureLook, index: number, count: number, clock: Clock): Beam[] {
  const ctx: EffectContext = {
    time: clock.time,
    beat: clock.beat,
    index,
    count,
    fixture,
    level: clock.level,
    shapes: show.shapes,
  };
  const half = fixture.scanAngle / 2;
  // Projectors can't steer past their scan field; clip beams that would.
  return computeBeams(look.effect, ctx).filter((b) => Math.abs(b.x - look.effect.pan) <= half + 1e-6); 
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
