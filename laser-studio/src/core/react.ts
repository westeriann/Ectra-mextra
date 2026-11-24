// Audio reactions: route live sound (kick, bass, hats…) to how every look
// behaves — brightness, size, spread, tilt, sway, colour, flash. Works on top
// of any cue, so reacting to music needs no per-cue setup. Modelled on
// Amethyst's modulation routes.

import type { AudioFeatures } from './live';
import { uid } from './util';

export const REACT_SOURCES = {
  kick: 'Kick drum',
  bass: 'Bass',
  mid: 'Mids',
  treble: 'Treble',
  level: 'Overall level',
  snare: 'Snare / clap',
  hat: 'Hi-hats',
  beat: 'Beat pulse',
} as const;
export type ReactSource = keyof typeof REACT_SOURCES;

export const REACT_TARGETS = {
  brightness: 'Brightness',
  size: 'Size',
  spread: 'Spread',
  tilt: 'Tilt up',
  sway: 'Sway left/right',
  hue: 'Colour shift',
  flash: 'White flash',
} as const;
export type ReactTarget = keyof typeof REACT_TARGETS;

export interface ReactRoute {
  id: string;
  source: ReactSource;
  target: ReactTarget;
  /** 0..1 */
  amount: number;
  on: boolean;
}

export interface AudioReactSettings {
  /** Master amount for every reaction, 0..1. */
  amount: number;
  routes: ReactRoute[];
  /** With live audio and no song playing, beat-synced effects follow the detected tempo. */
  followTempo: boolean;
}

export const REACT_PRESETS: { id: string; label: string; hint: string; source: ReactSource; target: ReactTarget; amount: number }[] = [
  { id: 'kick-pump', label: 'Kick pump', hint: 'Lasers punch brighter on every kick', source: 'kick', target: 'brightness', amount: 0.7 },
  { id: 'bass-breathe', label: 'Bass breathes', hint: 'Looks grow with the bass', source: 'bass', target: 'size', amount: 0.45 },
  { id: 'hat-shimmer', label: 'Hat shimmer', hint: 'Fans open a little on hi-hats', source: 'hat', target: 'spread', amount: 0.35 },
  { id: 'snare-colour', label: 'Snare colour', hint: 'Colour jumps on snares and claps', source: 'snare', target: 'hue', amount: 0.4 },
  { id: 'beat-sway', label: 'Beat sway', hint: 'Everything sways with the beat', source: 'beat', target: 'sway', amount: 0.4 },
  { id: 'kick-flash', label: 'Kick flash', hint: 'A white flash on big kicks', source: 'kick', target: 'flash', amount: 0.3 },
];

export function defaultAudioReact(): AudioReactSettings {
  return { amount: 1, routes: [], followTempo: true };
}

export function routeFromPreset(id: string): ReactRoute | null {
  const p = REACT_PRESETS.find((x) => x.id === id);
  return p ? { id: uid('rt'), source: p.source, target: p.target, amount: p.amount, on: true } : null;
}

/** Which preset (if any) a route corresponds to. */
export function presetOf(r: ReactRoute): string | undefined {
  return REACT_PRESETS.find((p) => p.source === r.source && p.target === r.target)?.id;
}

export interface AudioMods {
  intensity: number;
  size: number;
  spread: number;
  tilt: number;
  pan: number;
  hue: number;
  flash: number;
}

export const NO_AUDIO: AudioMods = { intensity: 1, size: 1, spread: 1, tilt: 0, pan: 0, hue: 0, flash: 0 };

export function audioMods(s: AudioReactSettings | undefined, f: AudioFeatures | undefined, beat: number): AudioMods {
  if (!s || !f || !f.active || s.amount <= 0) return NO_AUDIO;
  const m = { ...NO_AUDIO };
  for (const r of s.routes) {
    if (!r.on || r.amount <= 0) continue;
    const a = r.amount * s.amount;
    const v = f[r.source];
    switch (r.target) {
      case 'brightness':
        // Dim between hits, full on the hit: more amount = more contrast.
        m.intensity *= 1 - a * 0.85 * (1 - v);
        break;
      case 'size':
        m.size *= 1 + a * v;
        break;
      case 'spread':
        m.spread *= 1 + a * 0.8 * v;
        break;
      case 'tilt':
        m.tilt += a * 18 * v;
        break;
      case 'sway':
        // Alternate direction every beat.
        m.pan += a * 22 * v * (Math.floor(beat) % 2 === 0 ? 1 : -1);
        break;
      case 'hue':
        m.hue += a * 0.5 * v;
        break;
      case 'flash':
        m.flash = Math.max(m.flash, a * v);
        break;
    }
  }
  return m;
}
