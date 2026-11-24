// Map the current look of each fixture onto DMX channels for Art-Net output.
// Uses a simple generic 10-channel laser profile:
//   1 dimmer · 2 effect · 3 pan · 4 tilt · 5 size · 6 speed · 7 red · 8 green · 9 blue · 10 strobe

import type { FixtureFrame, FixtureLook, Show } from './types';
import { EFFECT_KINDS } from './types';
import { clamp, hexToRgb } from './util';

export const PROFILE_CHANNELS = ['Dimmer', 'Effect', 'Pan', 'Tilt', 'Size', 'Speed', 'Red', 'Green', 'Blue', 'Strobe'];

const byte = (v: number) => Math.round(clamp(v, 0, 1) * 255);

export function fixtureChannels(look: FixtureLook | undefined, frame: FixtureFrame | undefined): number[] {
  if (!look || !look.on || !frame || frame.beams.length === 0) return new Array(10).fill(0);
  const e = look.effect;
  const lit = frame.beams;
  const avg = lit.reduce((s, b) => s + b.a, 0) / lit.length;
  // Use the look's own colour; only rainbow/ILDA colours come from the beams on stage.
  const fromBeams = e.colorMode === 'rainbow' || e.colorMode === 'source';
  const [r, g, b] = fromBeams ? [lit[0].r, lit[0].g, lit[0].b] : hexToRgb(e.color);
  return [
    byte(avg),
    Math.min(255, EFFECT_KINDS.indexOf(e.kind) * 20 + 5),
    byte((e.pan + 90) / 180),
    byte((e.tilt + 90) / 180),
    byte(e.size / 90),
    byte(e.speed / 4),
    byte(r),
    byte(g),
    byte(b),
    byte(e.strobe / 16),
  ];
}

/** Build every DMX universe that has fixtures patched into it. */
export function buildUniverses(show: Show, frames: FixtureFrame[], looks: Record<string, FixtureLook>): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const frameById = new Map(frames.map((f) => [f.fixtureId, f]));
  for (const f of show.fixtures) {
    const u = f.dmx.universe;
    if (!out.has(u)) out.set(u, new Uint8Array(512));
    const data = out.get(u)!;
    const ch = fixtureChannels(looks[f.id], frameById.get(f.id));
    const start = f.dmx.address - 1;
    ch.forEach((v, i) => {
      if (start + i >= 0 && start + i < 512) data[start + i] = v;
    });
  }
  return out;
}
