import type { AutomationLane } from './automation';
import type { AudioReactSettings } from './react';

// Core data model for a Laser Studio show. Everything here is plain JSON so a
// show can be saved, loaded, sent to the output window, and diffed for undo.

export type Vec3 = [number, number, number];

/** A laser projector placed on the stage. */
export interface Fixture {
  id: string;
  name: string;
  /** Metres. Y is up, the stage is at negative Z, the audience at positive Z. */
  position: Vec3;
  /** Base aim in degrees: yaw (left/right) and pitch (up/down). */
  aim: [number, number];
  /** Hardware limit on simultaneous beams. */
  maxBeams: number;
  /** Full scan field of the projector in degrees. */
  scanAngle: number;
  /** 0..1 brightness scale (lets you model weaker/stronger projectors). */
  power: number;
  group: string;
  /** DMX patch for Art-Net output. Universe is 0-based, address is 1-based. */
  dmx: { universe: number; address: number };
  /** Optional Ether Dream DAC (IP address) this fixture streams to. */
  dac?: string;
}

export const EFFECT_KINDS = [
  'static',
  'fan',
  'sweep',
  'crossfan',
  'wave',
  'chase',
  'cone',
  'tunnel',
  'sheet',
  'spiral',
  'scatter',
  'shape',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const COLOR_MODES = ['solid', 'alternate', 'gradient', 'rainbow', 'source'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Parameters of the look a fixture is producing. */
export interface Effect {
  kind: EffectKind;
  beams: number;
  /** Width of the fan, degrees. */
  spread: number;
  /** Movement amount / radius, degrees. */
  size: number;
  /** Cycles per beat when `sync` is true, cycles per second otherwise. */
  speed: number;
  sync: boolean;
  /** Offsets relative to the fixture's aim, degrees. */
  pan: number;
  tilt: number;
  colorMode: ColorMode;
  color: string;
  color2: string;
  intensity: number;
  /** Strobe rate: flashes per beat when synced, Hz otherwise. 0 = off. */
  strobe: number;
  /** Phase offset spread across fixtures (0..1) to make chases between lasers. */
  phaseSpread: number;
  /** Mirror horizontal movement for fixtures on stage-right. */
  mirror: boolean;
  /** How strongly the audio level drives intensity (0..1). */
  audioReact: number;
  /** For `shape`: id of an imported ILDA shape. */
  shapeId?: string;
}

export interface FixtureLook {
  on: boolean;
  effect: Effect;
}

/** A saved look for (some or all) fixtures. Fixtures without a look are dark. */
export interface Cue {
  id: string;
  name: string;
  /** UI colour tag. */
  tag: string;
  /** Crossfade-in time, seconds. */
  fade: number;
  /** morph: beams move from the previous look into this one. dissolve: one fades out as the other fades in. */
  transition: 'morph' | 'dissolve';
  /** Created by "song → show". Replaced on regenerate unless you edit it. */
  auto?: boolean;
  looks: Record<string, FixtureLook>;
}

export type PadMode = 'flash' | 'toggle';

/** A busking button: fires a cue on top of whatever is running. */
export interface Pad {
  id: string;
  label: string;
  cueId: string | null;
  mode: PadMode;
  /** Keyboard key that triggers it (single character). */
  key: string;
  /** MIDI note/CC learned for it, "note:60" / "cc:12". */
  midi?: string;
}

export type StageElementKind =
  | 'floor'
  | 'platform'
  | 'truss'
  | 'screen'
  | 'speaker'
  | 'crowd'
  | 'wall'
  | 'pillar'
  | 'mirror'
  | 'mirrorball';

export interface StageElement {
  id: string;
  kind: StageElementKind;
  name: string;
  /** Centre of the element's footprint, sitting on `position[1]`. */
  position: Vec3;
  /** Width (x), height (y), depth (z) in metres. */
  size: Vec3;
  /** Rotation around the vertical axis, degrees. */
  rotation: number;
  color: string;
  /** Screens: what they show. Crowd: density 0..1 (stored in `density`). */
  screenMode?: 'pulse' | 'bars' | 'gradient' | 'off';
  density?: number;
  /** Mirrors: tilt up/down in degrees. */
  tilt?: number;
  /** Mirror balls: revolutions per second. */
  spin?: number;
}

export interface Stage {
  name: string;
  elements: StageElement[];
  /** 0..1, how visible beams are in the air. */
  haze: number;
  /** 0..1 house light level. */
  ambient: number;
  /** Beams stop at solid objects (screens, walls, risers…). Default on. */
  occlusion?: boolean;
  sky: string;
}

export type HitKind = 'flash' | 'strobe' | 'blackout';

export interface TimelineCue {
  id: string;
  time: number;
  cueId: string;
}

export interface TimelineHit {
  id: string;
  time: number;
  duration: number;
  kind: HitKind;
}

export interface Music {
  name: string;
  /** Absolute path on disk (desktop app) — the audio itself is not stored in the show. */
  path?: string;
  duration: number;
  bpm: number;
  /** Time in seconds of the first downbeat. */
  offset: number;
  beatsPerBar: number;
}

/** An imported ILDA vector shape. Coordinates are normalised to -1..1. */
export interface Shape {
  id: string;
  name: string;
  frames: ShapePoint[][];
}

export interface ShapePoint {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  blank: boolean;
}

export interface OutputSettings {
  artnet: { enabled: boolean; host: string; rate: number };
  osc: { enabled: boolean; port: number };
  /** `map` binds actions (go, back, blackout, master, tap, play) to "note:60" / "cc:7". */
  midi: { enabled: boolean; port: string | null; timecode: boolean; map: Record<string, string> };
  etherdream: { enabled: boolean; pps: number };
}

export interface Show {
  version: number;
  name: string;
  fixtures: Fixture[];
  cues: Cue[];
  pads: Pad[];
  stage: Stage;
  timeline: { cues: TimelineCue[]; hits: TimelineHit[]; lanes: AutomationLane[] };
  music: Music | null;
  /** Tempo used when no music is loaded (tap tempo sets this). */
  bpm: number;
  shapes: Shape[];
  output: OutputSettings;
  /** Live audio reactions (see react.ts). */
  audio: AudioReactSettings;
}

/** A single rendered beam, in fixture-local angles. */
export interface Beam {
  /** Horizontal angle relative to the fixture aim, degrees. */
  x: number;
  /** Vertical angle relative to the fixture aim, degrees. */
  y: number;
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export interface FixtureFrame {
  fixtureId: string;
  beams: Beam[];
}
