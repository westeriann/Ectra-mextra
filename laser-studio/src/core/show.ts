// Creating, validating and (de)serialising shows.

import { DEFAULT_EFFECT } from './effects';
import { defaultAudioReact } from './react';
import { templateById } from './stages';
import type { Cue, Effect, Fixture, FixtureLook, OutputSettings, Pad, Show } from './types';
import { uid } from './util';

export const SHOW_VERSION = 1;
export const FILE_EXTENSION = 'lshow';

export const DEFAULT_OUTPUT: OutputSettings = {
  artnet: { enabled: false, host: '255.255.255.255', rate: 40 },
  osc: { enabled: false, port: 9001 }, // 9000 is Amethyst VJ's OSC port
  midi: { enabled: false, port: null, timecode: false, map: {} },
  etherdream: { enabled: false, pps: 30000 },
};

export function effect(over: Partial<Effect> = {}): Effect {
  return { ...DEFAULT_EFFECT, ...over };
}

export function lookForAll(fixtures: Fixture[], e: Partial<Effect>): Record<string, FixtureLook> {
  return Object.fromEntries(fixtures.map((f) => [f.id, { on: true, effect: effect(e) }]));
}

export function makeCue(name: string, looks: Record<string, FixtureLook>, over: Partial<Cue> = {}): Cue {
  return { id: uid('cue'), name, tag: '#4cc9f0', fade: 0.5, transition: 'morph', looks, ...over };
}

/** Starter cues so a new show has something to play immediately. */
export function starterCues(fixtures: Fixture[]): Cue[] {
  return [
    makeCue('Green Fan', lookForAll(fixtures, { kind: 'fan', color: '#00ff40', speed: 0.25, size: 18 }), { tag: '#22c55e' }),
    makeCue('Blue Cones', lookForAll(fixtures, { kind: 'cone', color: '#2060ff', size: 10, speed: 0.25, tilt: -4 }), { tag: '#3b82f6' }),
    makeCue(
      'Rainbow Wave',
      lookForAll(fixtures, { kind: 'wave', colorMode: 'rainbow', beams: 12, spread: 70, size: 16, speed: 0.5 }),
      { tag: '#a855f7' },
    ),
    makeCue('Red Crossfan', lookForAll(fixtures, { kind: 'crossfan', color: '#ff1020', beams: 10, size: 30, speed: 0.5 }), {
      tag: '#ef4444',
    }),
    makeCue(
      'Liquid Sky',
      lookForAll(fixtures, { kind: 'sheet', color: '#00e0ff', color2: '#8000ff', colorMode: 'gradient', spread: 90, size: 8, tilt: -10, speed: 0.125 }),
      { tag: '#06b6d4', fade: 2 },
    ),
    makeCue('Chase', lookForAll(fixtures, { kind: 'chase', color: '#ffffff', beams: 12, spread: 80, speed: 1, phaseSpread: 1 }), {
      tag: '#f8fafc',
      fade: 0,
    }),
    makeCue('Strobe Hit', lookForAll(fixtures, { kind: 'static', color: '#ffffff', beams: 16, spread: 90, strobe: 4 }), {
      tag: '#facc15',
      fade: 0,
    }),
    makeCue('Tunnel', lookForAll(fixtures, { kind: 'tunnel', color: '#ff00c8', size: 12, speed: 0.25 }), { tag: '#ec4899', fade: 1 }),
  ];
}

export function starterPads(cues: Cue[]): Pad[] {
  const keys = '12345678';
  return Array.from({ length: 8 }, (_, i) => ({
    id: uid('pad'),
    label: cues[i]?.name ?? `Pad ${i + 1}`,
    cueId: cues[i]?.id ?? null,
    mode: 'flash' as const,
    key: keys[i],
  }));
}

export function newShow(templateId = 'arena'): Show {
  const { stage, fixtures } = templateById(templateId).build();
  const cues = starterCues(fixtures);
  return {
    version: SHOW_VERSION,
    name: 'Untitled Show',
    fixtures,
    cues,
    pads: starterPads(cues),
    stage,
    timeline: { cues: [], hits: [], lanes: [] },
    music: null,
    bpm: 128,
    shapes: [],
    output: structuredClone(DEFAULT_OUTPUT),
    audio: defaultAudioReact(),
  };
}

export function serializeShow(show: Show): string {
  return JSON.stringify(show, null, 2);
}

/**
 * Parse a show file, filling in anything missing so files from older versions
 * (or hand-edited ones) still open. Throws on input that isn't a show at all.
 */
export function parseShow(text: string): Show {
  const raw = JSON.parse(text) as Partial<Show>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fixtures) || !raw.stage) {
    throw new Error('This file is not a Laser Studio show.');
  }
  const base = newShow('empty');
  const show: Show = {
    ...base,
    ...raw,
    version: SHOW_VERSION,
    cues: (raw.cues ?? []).map((c) => ({
      ...c,
      transition: c.transition === 'dissolve' ? 'dissolve' : 'morph',
      looks: Object.fromEntries(Object.entries(c.looks ?? {}).map(([k, l]) => [k, { on: l.on !== false, effect: effect(l.effect) }])),
    })),
    pads: raw.pads ?? [],
    timeline: { cues: raw.timeline?.cues ?? [], hits: raw.timeline?.hits ?? [], lanes: raw.timeline?.lanes ?? [] },
    music: raw.music ?? null,
    bpm: raw.bpm ?? 128,
    audio: { ...defaultAudioReact(), ...raw.audio },
    shapes: raw.shapes ?? [],
    output: {
      artnet: { ...DEFAULT_OUTPUT.artnet, ...raw.output?.artnet },
      osc: { ...DEFAULT_OUTPUT.osc, ...raw.output?.osc },
      midi: { ...DEFAULT_OUTPUT.midi, ...raw.output?.midi },
      etherdream: { ...DEFAULT_OUTPUT.etherdream, ...raw.output?.etherdream },
    },
  };
  show.fixtures = show.fixtures.map((f) => ({ ...base.fixtures[0], ...f, dmx: f.dmx ?? { universe: 0, address: 1 } }));
  return show;
}
