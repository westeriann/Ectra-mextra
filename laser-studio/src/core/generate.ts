// "Drop a song, get a show": maps a track into sections (intro, build, drop…)
// and designs brand-new cues for it — a palette derived from the song,
// different effects per laser group, variations every few bars, hits around
// the drops and build-up automation. Deterministic per song + seed, so the
// same song always gives the same show and "Remix" gives a fresh one.

import type { Analysis } from './analysis';
import type { AutomationLane, AutoPoint } from './automation';
import { effect, makeCue } from './show';
import type { ColorMode, Cue, Effect, EffectKind, Fixture, FixtureLook, Music, Show, TimelineCue, TimelineHit } from './types';
import { clamp, fract, hsv, rgbToHex, uid } from './util';

export type Vibe = 'auto' | 'energetic' | 'chill' | 'psychedelic' | 'minimal';
export const VIBES: { value: Vibe; label: string }[] = [
  { value: 'auto', label: 'Auto (follow the song)' },
  { value: 'energetic', label: 'Energetic — fast, strobes, contrast' },
  { value: 'chill', label: 'Chill — slow sheets and cool colours' },
  { value: 'psychedelic', label: 'Psychedelic — rainbows, spirals, tunnels' },
  { value: 'minimal', label: 'Minimal — few beams, one colour' },
];

export type SectionKind = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro';

export interface Section {
  kind: SectionKind;
  startBar: number;
  bars: number;
  start: number;
  end: number;
  energy: number;
  brightness: number;
  busy: number;
}

// ------------------------------------------------------------------ random

/** Small, fast seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length) % xs.length],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

/** A stable number that identifies a song from its analysis. */
export function fingerprint(a: Analysis): number {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= Math.round(v * 1000) & 0xffff;
    h = Math.imul(h, 16777619);
  };
  mix(a.bpm);
  mix(a.duration);
  for (let i = 0; i < a.barEnergy.length; i++) {
    mix(a.barEnergy[i]);
    mix(a.barBrightness[i] ?? 0);
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ song map

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

/**
 * Split the song into phrases and label them. Boundaries sit on 4-bar phrase
 * lines where the loudness changes noticeably (or at the latest every 16 bars).
 */
export function mapSong(a: Analysis, music: Pick<Music, 'bpm' | 'offset' | 'beatsPerBar'>): Section[] {
  const n = a.barEnergy.length;
  const barLen = (60 / music.bpm) * music.beatsPerBar;
  if (!n) return [];
  const e = a.barEnergy;
  const cuts = [0];
  for (let b = 4; b < n - 2; b += 4) {
    const before = avg(e.slice(Math.max(cuts[cuts.length - 1], b - 4), b));
    const after = avg(e.slice(b, Math.min(n, b + 4)));
    const sinceLast = b - cuts[cuts.length - 1];
    if (Math.abs(after - before) > 0.18 || sinceLast >= 16) cuts.push(b);
  }
  cuts.push(n);
  const raw = cuts.slice(0, -1).map((startBar, i) => {
    const endBar = cuts[i + 1];
    const slice = (xs: number[]) => xs.slice(startBar, endBar);
    return {
      startBar,
      bars: endBar - startBar,
      energy: avg(slice(e)),
      brightness: avg(slice(a.barBrightness)),
      busy: avg(slice(a.barBusy)),
    };
  });
  const loudest = Math.max(...raw.map((r) => r.energy));
  const sections: Section[] = raw.map((r, i) => {
    const rel = r.energy / Math.max(loudest, 1e-9);
    const next = raw[i + 1];
    const nextRel = next ? next.energy / loudest : 0;
    let kind: SectionKind;
    if (rel > 0.78) kind = 'drop';
    else if (i === 0) kind = 'intro';
    else if (i === raw.length - 1 && rel < 0.7) kind = 'outro';
    // A build is mid-energy and leads into a drop; a quiet patch before a drop is a breakdown.
    else if (nextRel > 0.78 && nextRel - rel > 0.12 && rel >= 0.45) kind = 'build';
    else if (rel < 0.5) kind = 'breakdown';
    else kind = 'groove';
    return {
      ...r,
      kind,
      start: Math.max(0, music.offset + r.startBar * barLen),
      end: Math.min(a.duration, music.offset + (r.startBar + r.bars) * barLen),
    };
  });
  // The very first section always starts at 0 so the show is lit from the top.
  if (sections.length) sections[0].start = 0;
  return sections;
}

// ------------------------------------------------------------------ palette

export interface Palette {
  colors: string[];
  /** A cooler/brighter accent for bright sections. */
  accent: string;
}

export function makePalette(r: Rng, a: Analysis, vibe: Vibe): Palette {
  const bright = avg(a.barBrightness);
  // Brighter-sounding songs lean towards cyan/blue/magenta, darker ones towards red/orange/purple.
  let base = bright > 0.5 ? r.range(0.45, 0.85) : fract(r.range(0.85, 1.15));
  if (vibe === 'chill') base = r.range(0.45, 0.7);
  const spread = vibe === 'minimal' ? 0.04 : vibe === 'chill' ? 0.12 : vibe === 'psychedelic' ? 0.33 : r.pick([0.08, 0.17, 0.33, 0.5]);
  const hues = [base, base + spread, base - spread, base + 0.5];
  const colors = hues.map((h) => rgbToHex(hsv(fract(h), 1, 1)));
  return { colors, accent: rgbToHex(hsv(fract(base + 0.5 + r.range(-0.05, 0.05)), 0.35, 1)) };
}

// ------------------------------------------------------------------ looks

const KINDS: Record<SectionKind, EffectKind[]> = {
  intro: ['sheet', 'cone', 'tunnel', 'static', 'wave'],
  groove: ['fan', 'wave', 'sweep', 'cone', 'crossfan'],
  build: ['wave', 'fan', 'chase', 'spiral', 'sweep'],
  drop: ['crossfan', 'chase', 'scatter', 'fan', 'tunnel', 'cone'],
  breakdown: ['sheet', 'tunnel', 'cone', 'spiral', 'wave'],
  outro: ['sheet', 'static', 'cone', 'fan'],
};

const SPEED: Record<SectionKind, number[]> = {
  intro: [0.0625, 0.125],
  groove: [0.25, 0.5],
  build: [0.25, 0.5],
  drop: [0.5, 1, 2],
  breakdown: [0.0625, 0.125, 0.25],
  outro: [0.0625, 0.125],
};

const LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  groove: 'Groove',
  build: 'Build',
  drop: 'Drop',
  breakdown: 'Breakdown',
  outro: 'Outro',
};

const KIND_NAMES: Partial<Record<EffectKind, string>> = { sheet: 'Sky', static: 'Fan', crossfan: 'Crossfan', scatter: 'Scatter' };

function colorName(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 60) return 'White';
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const names: [number, string][] = [
    [15, 'Red'], [40, 'Orange'], [70, 'Gold'], [150, 'Green'], [190, 'Teal'], [225, 'Cyan'], [255, 'Blue'], [290, 'Violet'], [335, 'Magenta'], [360, 'Red'],
  ];
  return names.find(([lim]) => h < lim)?.[1] ?? 'Red';
}

interface LookPlan {
  section: Section;
  palette: Palette;
  vibe: Vibe;
  /** 0 for the main look of a section, 1.. for variations. */
  variant: number;
}

/** Design one effect for one laser group. */
function designEffect(r: Rng, plan: LookPlan, groupIndex: number, avgY: number): Effect {
  const { section: s, palette, vibe } = plan;
  let pool = KINDS[s.kind];
  if (vibe === 'psychedelic') pool = [...pool, 'spiral', 'tunnel', 'spiral'];
  if (vibe === 'chill') pool = pool.filter((k) => !['scatter', 'chase', 'crossfan'].includes(k)).concat(['sheet', 'cone']);
  if (vibe === 'minimal') pool = ['static', 'fan', 'sweep', 'sheet'];
  const kind = r.pick(pool);

  const intense = s.kind === 'drop' || vibe === 'energetic';
  let speed = r.pick(SPEED[s.kind]);
  if (vibe === 'chill') speed /= 2;
  if (vibe === 'energetic' && s.kind !== 'intro' && s.kind !== 'outro') speed *= 2;

  // Colours: each group gets its own palette slot so the rig has depth.
  const c1 = s.brightness > 0.7 && r.chance(0.4) ? palette.accent : palette.colors[(groupIndex + plan.variant) % palette.colors.length];
  const c2 = palette.colors[(groupIndex + plan.variant + 1) % palette.colors.length];
  let colorMode: ColorMode = 'solid';
  if (vibe === 'psychedelic' && r.chance(0.6)) colorMode = 'rainbow';
  else if (vibe !== 'minimal') colorMode = r.pick(s.kind === 'drop' ? ['solid', 'alternate', 'solid'] : ['solid', 'gradient', 'solid']);

  const beams = Math.round(vibe === 'minimal' ? r.range(2, 5) : 4 + s.busy * 12 + (intense ? 4 : 0) + r.range(-2, 2));
  const high = avgY > 5;
  const tilt =
    kind === 'sheet' ? (high ? r.range(-12, -5) : r.range(4, 10)) : high ? r.range(-8, 4) : r.range(0, 14);
  const strobe = vibe !== 'chill' && s.kind === 'drop' && plan.variant % 2 === 1 && groupIndex === 0 ? r.pick([2, 4]) : 0;

  return effect({
    kind,
    beams: clamp(beams, 2, 24),
    spread: kind === 'sheet' ? r.range(70, 110) : r.range(35, 90),
    size: kind === 'cone' || kind === 'tunnel' ? r.range(6, 14) : kind === 'sheet' ? r.range(4, 10) : r.range(10, 32),
    speed,
    sync: true,
    pan: 0,
    tilt: Math.round(tilt),
    colorMode,
    color: c1,
    color2: c2,
    intensity: clamp(0.55 + s.energy * 0.45, 0.4, 1),
    strobe,
    phaseSpread: intense ? r.pick([0.5, 1]) : r.pick([0, 0.25, 0.5]),
    mirror: r.chance(0.8),
    audioReact: s.kind === 'drop' ? 0.35 : s.kind === 'groove' ? 0.2 : 0,
  });
}

function designCue(r: Rng, plan: LookPlan, groups: Map<string, Fixture[]>, n: number): Cue {
  const looks: Record<string, FixtureLook> = {};
  const names = [...groups.keys()];
  // In quiet sections sometimes only part of the rig plays — it makes the drops hit harder.
  const quiet = plan.section.kind === 'intro' || plan.section.kind === 'breakdown' || plan.section.kind === 'outro';
  const active = quiet && names.length > 1 ? names.filter((_, i) => i === 0 || r.chance(0.5)) : names;
  let main: Effect | null = null;
  names.forEach((g, gi) => {
    const fixtures = groups.get(g)!;
    const avgY = avg(fixtures.map((f) => f.position[1]));
    const e = designEffect(r, plan, gi, avgY);
    main ??= e;
    for (const f of fixtures) looks[f.id] = { on: active.includes(g), effect: { ...e } };
  });
  const s = plan.section;
  const m = main as Effect | null;
  const kindName = m ? KIND_NAMES[m.kind] ?? m.kind[0].toUpperCase() + m.kind.slice(1) : '';
  const suffix = plan.variant ? ` ${String.fromCharCode(65 + plan.variant)}` : '';
  return makeCue(`${LABEL[s.kind]} ${n} · ${m ? colorName(m.color) : ''} ${kindName}${suffix}`.replace(/\s+/g, ' ').trim(), looks, {
    tag: m?.color ?? '#4cc9f0',
    fade: s.kind === 'drop' ? 0 : s.kind === 'build' ? 0.5 : plan.variant ? 1 : 2.5,
    transition: 'morph',
    auto: true,
  });
}

// ------------------------------------------------------------------ show

export interface GenerateOptions {
  vibe: Vibe;
  /** 0 = the song's own show; other numbers = remixes. */
  variation: number;
  /** Change look every N bars inside long sections. */
  barsPerVariation: number;
}

export interface Generated {
  cues: Cue[];
  timeline: { cues: TimelineCue[]; hits: TimelineHit[]; lanes: AutomationLane[] };
  sections: Section[];
  palette: Palette;
}

export function generateShow(show: Show, a: Analysis, music: Music, opts: GenerateOptions): Generated {
  const r = rng(fingerprint(a) ^ Math.imul(opts.variation + 1, 0x9e3779b1));
  const vibe: Vibe = opts.vibe === 'auto' ? autoVibe(a, r) : opts.vibe;
  const palette = makePalette(r, a, vibe);
  const sections = mapSong(a, music);
  const groups = new Map<string, Fixture[]>();
  for (const f of show.fixtures) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group)!.push(f);
  }
  const barLen = (60 / music.bpm) * music.beatsPerBar;
  const beat = 60 / music.bpm;
  const cues: Cue[] = [];
  const tl: TimelineCue[] = [];
  const hits: TimelineHit[] = [];
  const counters: Partial<Record<SectionKind, number>> = {};

  for (const s of sections) {
    const n = (counters[s.kind] = (counters[s.kind] ?? 0) + 1);
    const variants = Math.max(1, Math.ceil(s.bars / Math.max(1, opts.barsPerVariation)));
    const base = designCue(r, { section: s, palette, vibe, variant: 0 }, groups, n);
    cues.push(base);
    tl.push({ id: uid('tc'), time: s.start, cueId: base.id });
    for (let v = 1; v < variants; v++) {
      const cue = designCue(r, { section: s, palette, vibe, variant: v }, groups, n);
      cues.push(cue);
      tl.push({ id: uid('tc'), time: s.start + v * opts.barsPerVariation * barLen, cueId: cue.id });
    }
    if (s.kind === 'drop' && s.start > barLen) {
      // The classic drop: strobe through the last bar, a half-beat of darkness, then a flash.
      if (vibe !== 'chill' && vibe !== 'minimal') hits.push({ id: uid('hit'), time: s.start - barLen, duration: barLen - beat / 2, kind: 'strobe' });
      hits.push({ id: uid('hit'), time: s.start - beat / 2, duration: beat / 2, kind: 'blackout' });
      hits.push({ id: uid('hit'), time: s.start, duration: 0.6, kind: 'flash' });
      if (vibe === 'energetic') {
        for (let b = 4; b < s.bars; b += 4) hits.push({ id: uid('hit'), time: s.start + b * barLen, duration: 0.3, kind: 'flash' });
      }
    }
  }

  return { cues, timeline: { cues: tl, hits, lanes: makeLanes(sections, a, music, vibe, r) }, sections, palette };
}

function autoVibe(a: Analysis, r: Rng): Vibe {
  const tempo = a.bpm;
  const dynamics = Math.max(...a.barEnergy) - avg(a.barEnergy);
  if (tempo < 100 && dynamics < 0.3) return 'chill';
  if (tempo >= 135 || dynamics > 0.45) return 'energetic';
  return r.pick(['energetic', 'psychedelic', 'auto' as Vibe]) === 'psychedelic' ? 'psychedelic' : 'energetic';
}

function makeLanes(sections: Section[], a: Analysis, music: Music, vibe: Vibe, r: Rng): AutomationLane[] {
  const intensity: AutoPoint[] = [];
  const speed: AutoPoint[] = [];
  const pt = (time: number, value: number, curve: AutoPoint['curve'] = 'linear'): AutoPoint => ({ id: uid('pt'), time: Math.max(0, time), value, curve });
  const barLen = (60 / music.bpm) * music.beatsPerBar;

  // Fade in over the first two bars, out over the last four.
  intensity.push(pt(0, 0, 'smooth'), pt(Math.min(2 * barLen, a.duration / 4), 1));
  for (const s of sections) {
    if (s.kind !== 'build') continue;
    // Builds: lights pull back then rise into the drop while movement speeds up.
    intensity.push(pt(s.start, 0.45, 'smooth'), pt(s.end - 0.01, 1, 'hold'), pt(s.end, 1));
    speed.push(pt(s.start, 1, 'smooth'), pt(s.end - 0.01, 2.5, 'hold'), pt(s.end, 1));
  }
  const end = a.duration;
  intensity.push(pt(Math.max(0, end - 4 * barLen), 1, 'smooth'), pt(end, 0));
  intensity.sort((x, y) => x.time - y.time);
  speed.sort((x, y) => x.time - y.time);

  const lanes: AutomationLane[] = [{ id: uid('lane'), param: 'intensity', target: 'all', enabled: true, points: intensity }];
  if (speed.length) lanes.push({ id: uid('lane'), param: 'speed', target: 'all', enabled: true, points: speed });
  if (vibe === 'psychedelic' || r.chance(0.35)) {
    // A slow colour drift across the whole song.
    const amount = vibe === 'psychedelic' ? 1 : r.range(0.08, 0.2);
    lanes.push({ id: uid('lane'), param: 'hue', target: 'all', enabled: true, points: [pt(0, 0), pt(end, Math.min(1, amount))] });
  }
  return lanes;
}
