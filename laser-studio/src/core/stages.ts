// Built-in stage templates. The stage designer edits a copy of one of these;
// you can also start from an empty floor.

import type { Fixture, Stage, StageElement, StageElementKind, Vec3 } from './types';
import { uid } from './util';

export const ELEMENT_DEFAULTS: Record<StageElementKind, Omit<StageElement, 'id' | 'position'>> = {
  floor: { kind: 'floor', name: 'Floor', size: [60, 0.1, 60], rotation: 0, color: '#15171f' },
  platform: { kind: 'platform', name: 'Riser', size: [8, 1.2, 4], rotation: 0, color: '#23252e' },
  truss: { kind: 'truss', name: 'Truss', size: [14, 0.4, 0.4], rotation: 0, color: '#8a8f99' },
  screen: { kind: 'screen', name: 'LED Screen', size: [10, 5, 0.3], rotation: 0, color: '#101018', screenMode: 'pulse' },
  speaker: { kind: 'speaker', name: 'Speaker Stack', size: [1.4, 4, 1.2], rotation: 0, color: '#0c0c10' },
  crowd: { kind: 'crowd', name: 'Crowd', size: [24, 1.7, 16], rotation: 0, color: '#1b1d26', density: 0.6 },
  wall: { kind: 'wall', name: 'Wall', size: [30, 10, 0.5], rotation: 0, color: '#101118' },
  pillar: { kind: 'pillar', name: 'Pillar', size: [0.8, 8, 0.8], rotation: 0, color: '#2a2c36' },
  mirror: { kind: 'mirror', name: 'Mirror', size: [2, 2, 0.05], rotation: 0, color: '#c8d0e0', tilt: 0 },
  mirrorball: { kind: 'mirrorball', name: 'Mirror Ball', size: [0.8, 0.8, 0.8], rotation: 0, color: '#d0d6e4', spin: 0.08 },
};

export function makeElement(kind: StageElementKind, position: Vec3, over: Partial<StageElement> = {}): StageElement {
  return { ...structuredClone(ELEMENT_DEFAULTS[kind]), id: uid('el'), position, ...over };
}

export function makeFixture(name: string, position: Vec3, over: Partial<Fixture> = {}): Fixture {
  return {
    id: uid('fx'),
    name,
    position,
    aim: [0, 12],
    maxBeams: 32,
    scanAngle: 100,
    power: 1,
    group: 'Lasers',
    dmx: { universe: 0, address: 1 },
    ...over,
  };
}

export interface StageTemplate {
  id: string;
  name: string;
  description: string;
  build: () => { stage: Stage; fixtures: Fixture[] };
}

/** Patch fixtures 10 DMX channels apart so a new template works with Art-Net straight away. */
function patch(fixtures: Fixture[]): Fixture[] {
  fixtures.forEach((f, i) => (f.dmx = { universe: 0, address: 1 + i * 10 }));
  return fixtures;
}

function row(count: number, width: number, y: number, z: number, group: string, aim: [number, number]): Fixture[] {
  return Array.from({ length: count }, (_, i) => {
    const x = count > 1 ? -width / 2 + (width * i) / (count - 1) : 0;
    return makeFixture(`${group} ${i + 1}`, [round(x), y, z], { group, aim: [...aim] as [number, number] });
  });
}
const round = (v: number) => Math.round(v * 100) / 100;

export const STAGE_TEMPLATES: StageTemplate[] = [
  {
    id: 'club',
    name: 'Club',
    description: 'Small room, DJ booth, low ceiling, lasers above the booth.',
    build: () => ({
      stage: {
        name: 'Club',
        haze: 0.75,
        ambient: 0.08,
        sky: '#05050a',
        elements: [
          makeElement('floor', [0, 0, 0], { size: [30, 0.1, 30] }),
          makeElement('wall', [0, 0, -9], { size: [24, 7, 0.4], name: 'Back Wall' }),
          makeElement('platform', [0, 0, -6.5], { size: [6, 1, 3], name: 'DJ Booth' }),
          makeElement('screen', [0, 2, -8.6], { size: [8, 3.5, 0.2] }),
          makeElement('truss', [0, 5, -6], { size: [12, 0.35, 0.35], name: 'Laser Bar' }),
          makeElement('speaker', [-6, 0, -6], {}),
          makeElement('speaker', [6, 0, -6], {}),
          makeElement('crowd', [0, 0, 3], { size: [16, 1.7, 12], density: 0.7 }),
          makeElement('mirrorball', [0, 4.4, -1], { size: [0.8, 0.8, 0.8] }),
        ],
      },
      fixtures: patch(row(4, 9, 4.7, -6, 'Bar', [0, 2])),
    }),
  },
  {
    id: 'arena',
    name: 'Arena',
    description: 'Big end-stage with an overhead truss line, side towers and a wide floor.',
    build: () => ({
      stage: {
        name: 'Arena',
        haze: 0.6,
        ambient: 0.05,
        sky: '#03040a',
        elements: [
          makeElement('floor', [0, 0, 10], { size: [90, 0.1, 90] }),
          makeElement('platform', [0, 0, -10], { size: [26, 1.8, 12], name: 'Main Stage' }),
          makeElement('screen', [0, 3, -15.5], { size: [20, 9, 0.3], screenMode: 'bars' }),
          makeElement('screen', [-19, 4, -10], { size: [7, 5, 0.3], rotation: 15, name: 'Side Screen L' }),
          makeElement('screen', [19, 4, -10], { size: [7, 5, 0.3], rotation: -15, name: 'Side Screen R' }),
          makeElement('truss', [0, 13, -8], { size: [30, 0.6, 0.6], name: 'Front Truss' }),
          makeElement('truss', [0, 14, -14], { size: [30, 0.6, 0.6], name: 'Rear Truss' }),
          makeElement('pillar', [-15, 0, -8], { size: [1, 14, 1], name: 'Tower L' }),
          makeElement('pillar', [15, 0, -8], { size: [1, 14, 1], name: 'Tower R' }),
          makeElement('speaker', [-14, 7, -5], { size: [1.6, 6, 1.4], name: 'PA Hang L' }),
          makeElement('speaker', [14, 7, -5], { size: [1.6, 6, 1.4], name: 'PA Hang R' }),
          makeElement('crowd', [0, 0, 14], { size: [40, 1.7, 28], density: 0.75 }),
        ],
      },
      fixtures: patch([
        ...row(6, 24, 12.6, -8, 'Front Truss', [0, 0]),
        ...row(4, 18, 1.9, -5, 'Stage Edge', [0, 14]),
      ]),
    }),
  },
  {
    id: 'festival',
    name: 'Festival Main Stage',
    description: 'Open-air main stage with a roof, wings and lasers firing over a big field.',
    build: () => ({
      stage: {
        name: 'Festival Main Stage',
        haze: 0.45,
        ambient: 0.04,
        sky: '#060818',
        elements: [
          makeElement('floor', [0, 0, 20], { size: [140, 0.1, 140], color: '#0e1410', name: 'Field' }),
          makeElement('platform', [0, 0, -12], { size: [34, 2.2, 14], name: 'Stage Deck' }),
          makeElement('wall', [0, 2.2, -19], { size: [34, 16, 0.6], name: 'Backdrop' }),
          makeElement('platform', [0, 17.5, -12], { size: [38, 0.8, 16], name: 'Roof', color: '#1a1c24' }),
          makeElement('pillar', [-18, 0, -5], { size: [1.2, 18, 1.2], name: 'Roof Leg FL' }),
          makeElement('pillar', [18, 0, -5], { size: [1.2, 18, 1.2], name: 'Roof Leg FR' }),
          makeElement('screen', [0, 5, -18.4], { size: [24, 10, 0.3], screenMode: 'gradient' }),
          makeElement('screen', [-24, 3, -8], { size: [9, 12, 0.4], name: 'Wing L', screenMode: 'bars' }),
          makeElement('screen', [24, 3, -8], { size: [9, 12, 0.4], name: 'Wing R', screenMode: 'bars' }),
          makeElement('truss', [0, 16, -6], { size: [34, 0.7, 0.7], name: 'Front Truss' }),
          makeElement('platform', [0, 0, 32], { size: [8, 3, 6], name: 'FOH Tower', color: '#1c1e27' }),
          makeElement('crowd', [0, 0, 18], { size: [56, 1.7, 34], density: 0.8 }),
        ],
      },
      fixtures: patch([
        ...row(8, 30, 15.4, -6, 'Roof', [0, -4]),
        ...row(4, 26, 2.6, -5.5, 'Deck', [0, 16]),
        makeFixture('FOH Left', [-3, 3.4, 32], { group: 'FOH', aim: [180, 10] }),
        makeFixture('FOH Right', [3, 3.4, 32], { group: 'FOH', aim: [180, 10] }),
      ]),
    }),
  },
  {
    id: 'warehouse',
    name: 'Warehouse',
    description: 'Long concrete room with pillars — a classic for beams cutting through haze.',
    build: () => ({
      stage: {
        name: 'Warehouse',
        haze: 0.9,
        ambient: 0.03,
        sky: '#040406',
        elements: [
          makeElement('floor', [0, 0, 0], { size: [26, 0.1, 50], color: '#16161a' }),
          makeElement('wall', [-13, 0, 0], { size: [0.5, 9, 50], name: 'Wall L' }),
          makeElement('wall', [13, 0, 0], { size: [0.5, 9, 50], name: 'Wall R' }),
          makeElement('wall', [0, 0, -25], { size: [26, 9, 0.5], name: 'End Wall' }),
          ...[-15, -5, 5, 15].flatMap((z) => [
            makeElement('pillar', [-6, 0, z], { size: [0.7, 9, 0.7] }),
            makeElement('pillar', [6, 0, z], { size: [0.7, 9, 0.7] }),
          ]),
          makeElement('platform', [0, 0, -21], { size: [8, 1, 4], name: 'DJ Riser' }),
          // Mirrors at the back of the room bounce the end lasers back over the crowd.
          makeElement('mirror', [-5, 1.5, 24], { size: [6, 3, 0.05], rotation: 180, tilt: 8, name: 'Back Mirror L' }),
          makeElement('mirror', [5, 1.5, 24], { size: [6, 3, 0.05], rotation: 180, tilt: 8, name: 'Back Mirror R' }),
          makeElement('crowd', [0, 0, 0], { size: [18, 1.7, 30], density: 0.55 }),
        ],
      },
      fixtures: patch([
        ...row(3, 10, 7.5, -22, 'End', [0, -6]),
        makeFixture('Side L', [-12.5, 7.5, 0], { group: 'Side', aim: [90, -8] }),
        makeFixture('Side R', [12.5, 7.5, 0], { group: 'Side', aim: [-90, -8] }),
      ]),
    }),
  },
  {
    id: 'empty',
    name: 'Empty Floor',
    description: 'Just a floor and two lasers. Build your own stage from scratch.',
    build: () => ({
      stage: {
        name: 'Custom Stage',
        haze: 0.6,
        ambient: 0.06,
        sky: '#05060c',
        elements: [makeElement('floor', [0, 0, 0], { size: [60, 0.1, 60] })],
      },
      fixtures: patch([makeFixture('Laser 1', [-4, 4, -8]), makeFixture('Laser 2', [4, 4, -8])]),
    }),
  },
];

export function templateById(id: string): StageTemplate {
  return STAGE_TEMPLATES.find((t) => t.id === id) ?? STAGE_TEMPLATES[0];
}
