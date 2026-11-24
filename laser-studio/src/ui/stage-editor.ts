// Stage mode: design the venue. Element/fixture list (left), inspector
// (right) and a draggable top-down plan (bottom). The 3D view shows a move
// gizmo on the selected object.

import { ELEMENT_DEFAULTS, makeElement, makeFixture, STAGE_TEMPLATES } from '../core/stages';
import type { Fixture, Show, StageElement, StageElementKind, Vec3 } from '../core/types';
import { clamp, rad, uid } from '../core/util';
import { button, clear, colorInput, h, modal, numberInput, section, select, slider, textInput, toggle, vec3Input } from './dom';
import type { GizmoMode } from '../render/viewport';
import type { Studio } from './studio';

const KIND_ICONS: Record<StageElementKind, string> = {
  floor: '▭',
  platform: '▤',
  truss: '⫶',
  screen: '▣',
  speaker: '◫',
  crowd: '⁘',
  wall: '█',
  pillar: '▮',
  mirror: '◩',
  mirrorball: '◍',
};

const PLAN_COLORS: Record<StageElementKind, string> = {
  floor: '#1a1d28',
  platform: '#3a3f55',
  truss: '#8a8f99',
  screen: '#4c6fff',
  speaker: '#555b6e',
  crowd: '#2f6b4f',
  wall: '#454a5c',
  pillar: '#6b7080',
  mirror: '#c8d0e0',
  mirrorball: '#e2e8f0',
};

type Item = { kind: 'element'; el: StageElement } | { kind: 'fixture'; f: Fixture };

function findItem(show: Show, id: string | null): Item | null {
  if (!id) return null;
  const el = show.stage.elements.find((e) => e.id === id);
  if (el) return { kind: 'element', el };
  const f = show.fixtures.find((x) => x.id === id);
  return f ? { kind: 'fixture', f } : null;
}

export function mountStageList(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const add = (kind: StageElementKind) => {
    const spawn: Partial<Record<StageElementKind, Vec3>> = { truss: [0, 8, -6], crowd: [0, 0, 10], mirror: [0, 3, 4], mirrorball: [0, 5, 2] };
    const el = makeElement(kind, spawn[kind] ?? [0, 0, -6]);
    store.edit((s) => s.stage.elements.push(el));
    store.setSel({ element: el.id });
  };
  const addFixture = () => {
    const n = store.show.fixtures.length;
    const used = Math.max(0, ...store.show.fixtures.map((f) => f.dmx.address + 9));
    const f = makeFixture(`Laser ${n + 1}`, [0, 6, -6], { dmx: { universe: 0, address: Math.min(503, used + 1) } });
    store.edit((s) => s.fixtures.push(f));
    store.setSel({ element: f.id });
  };
  const addRow = async () => {
    let count = 6;
    let from = -10;
    let to = 10;
    let y = 8;
    let z = -6;
    let pitch = 5;
    let group = 'Row';
    const ok = await modal(
      'Add a row of lasers',
      h(
        'div',
        { class: 'form' },
        textInput({ label: 'Group name', value: group, onChange: (v) => (group = v) }),
        numberInput({ label: 'How many', value: count, step: 1, min: 1, max: 64, onChange: (v) => (count = Math.round(v)) }),
        numberInput({ label: 'From x (m)', value: from, onChange: (v) => (from = v) }),
        numberInput({ label: 'To x (m)', value: to, onChange: (v) => (to = v) }),
        numberInput({ label: 'Height (m)', value: y, onChange: (v) => (y = v) }),
        numberInput({ label: 'Depth z (m)', value: z, onChange: (v) => (z = v) }),
        numberInput({ label: 'Aim up/down (°)', value: pitch, onChange: (v) => (pitch = v) }),
      ),
      [
        { label: 'Cancel', value: false },
        { label: 'Add', value: true, primary: true },
      ],
    );
    if (!ok) return;
    let addr = Math.max(0, ...store.show.fixtures.map((f) => f.dmx.address + 9));
    const fixtures = Array.from({ length: count }, (_, i) => {
      const x = count > 1 ? from + ((to - from) * i) / (count - 1) : (from + to) / 2;
      const universe = Math.floor(addr / 510);
      const f = makeFixture(`${group} ${i + 1}`, [Math.round(x * 100) / 100, y, z], { group, aim: [0, pitch], dmx: { universe, address: (addr % 510) + 1 } });
      addr += 10;
      return f;
    });
    store.edit((s) => s.fixtures.push(...fixtures));
  };

  const render = () => {
    const selId = store.sel.element;
    const row = (id: string, icon: string, name: string, sub: string) =>
      h('button', { class: `fx-item ${selId === id ? 'selected' : ''}`, onclick: () => store.setSel({ element: id }) }, h('span', { class: 'icon' }, icon), name, h('span', { class: 'sub' }, sub));
    clear(
      root,
      h('div', { class: 'panel-head' }, h('h2', null, 'Stage')),
      h(
        'div',
        { class: 'add-grid' },
        ...(Object.keys(ELEMENT_DEFAULTS) as StageElementKind[]).map((k) => button(h('span', null, KIND_ICONS[k], ' ', ELEMENT_DEFAULTS[k].name), () => add(k), { class: 'btn btn-sm', title: `Add ${ELEMENT_DEFAULTS[k].name}` })),
      ),
      h('div', { class: 'list-title' }, 'Elements'),
      ...store.show.stage.elements.map((el) => row(el.id, KIND_ICONS[el.kind], el.name, el.kind)),
      h('div', { class: 'list-title' }, 'Lasers', h('span', { class: 'grow' }), button('＋ Laser', addFixture, { class: 'btn btn-xs' }), button('＋ Row', addRow, { class: 'btn btn-xs' })),
      ...store.show.fixtures.map((f) => row(f.id, '✦', f.name, `${f.dmx.universe}.${f.dmx.address}`)),
    );
  };
  render();
  store.subscribe((c) => (c.topics.has('show') || c.topics.has('sel')) && c.source !== 'inspector' && c.source !== 'plan' && render());
}

export function mountStageInspector(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const edit = (fn: (s: Show) => void, key: string) => store.edit(fn, { source: 'inspector', coalesce: key });

  function stageSettings() {
    const st = store.show.stage;
    return [
      h('div', { class: 'panel-head' }, h('h2', null, 'Venue')),
      section(
        'Atmosphere',
        textInput({ label: 'Stage name', value: st.name, onChange: (v) => edit((s) => (s.stage.name = v), 'name') }),
        slider({ label: 'Haze', value: st.haze, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => edit((s) => (s.stage.haze = v), 'haze') }),
        slider({ label: 'House lights', value: st.ambient, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => edit((s) => (s.stage.ambient = v), 'ambient') }),
        colorInput({ label: 'Sky', value: st.sky, onInput: (v) => edit((s) => (s.stage.sky = v), 'sky') }),
        toggle({
          label: 'Beams stop at solid objects',
          value: st.occlusion !== false,
          title: 'Screens, walls, risers, speakers and pillars block beams (and show where they land)',
          onChange: (v) => edit((s) => (s.stage.occlusion = v), 'occlusion'),
        }),
      ),
      section(
        'Start from a template',
        h('p', { class: 'hint' }, 'Replaces the stage and lasers. Cues are kept for lasers that still exist.'),
        ...STAGE_TEMPLATES.map((t) =>
          button(
            h('span', null, h('strong', null, t.name), h('br'), h('small', null, t.description)),
            async () => {
              const ok = await modal('Replace stage?', `Load the “${t.name}” template? Your current stage and lasers will be replaced (you can undo).`, [
                { label: 'Cancel', value: false },
                { label: 'Replace', value: true, primary: true },
              ]);
              if (!ok) return;
              const built = t.build();
              store.edit((s) => {
                s.stage = built.stage;
                s.fixtures = built.fixtures;
                // Re-target cue looks by position in the rig so existing cues keep working.
                for (const cue of s.cues) {
                  const looks = Object.values(cue.looks);
                  if (!looks.length) continue;
                  cue.looks = Object.fromEntries(built.fixtures.map((f, i) => [f.id, structuredClone(looks[i % looks.length])]));
                }
              });
              store.pruneSelection();
              studio.setCamera('foh');
            },
            { class: 'btn template-btn' },
          ),
        ),
      ),
    ];
  }

  function elementInspector(el: StageElement) {
    const id = el.id;
    const upd = (fn: (e: StageElement) => void, key: string) =>
      edit((s) => {
        const e = s.stage.elements.find((x) => x.id === id);
        if (e) fn(e);
      }, `${id}-${key}`);
    return [
      h('div', { class: 'panel-head' }, h('h2', null, `${KIND_ICONS[el.kind]} ${el.name}`)),
      section(
        'Element',
        textInput({ label: 'Name', value: el.name, onChange: (v) => upd((e) => (e.name = v), 'name') }),
        vec3Input('Position (m)', el.position, (v) => upd((e) => (e.position = v), 'pos')),
        vec3Input('Size w/h/d (m)', el.size, (v) => upd((e) => (e.size = v.map((n) => Math.max(0.05, n)) as Vec3), 'size')),
        slider({ label: 'Rotation', value: el.rotation, min: -180, max: 180, unit: '°', onInput: (v) => upd((e) => (e.rotation = v), 'rot') }),
        colorInput({ label: 'Colour', value: el.color, onInput: (v) => upd((e) => (e.color = v), 'color') }),
        el.kind === 'screen'
          ? select({ label: 'Screen content', value: el.screenMode ?? 'pulse', options: ['pulse', 'bars', 'gradient', 'off'] as const, onChange: (v) => upd((e) => (e.screenMode = v), 'screen') })
          : null,
        el.kind === 'mirror'
          ? slider({ label: 'Tilt', value: el.tilt ?? 0, min: -80, max: 80, unit: '°', title: 'Angle the mirror up or down', onInput: (v) => upd((e) => (e.tilt = v), 'tilt') })
          : null,
        el.kind === 'mirrorball'
          ? slider({ label: 'Spin', value: el.spin ?? 0.08, min: 0, max: 1, step: 0.01, unit: ' rev/s', onInput: (v) => upd((e) => (e.spin = v), 'spin') })
          : null,
        el.kind === 'mirrorball' ? h('p', { class: 'hint' }, 'Size sets the ball’s diameter. Aim lasers at it to split each beam into a spray of reflections.') : null,
        el.kind === 'mirror' ? h('p', { class: 'hint' }, 'Both faces reflect. Rotate and tilt it to bounce beams around the room.') : null,
        el.kind === 'crowd'
          ? slider({ label: 'Density', value: el.density ?? 0.6, min: 0.05, max: 1.5, step: 0.05, onInput: (v) => upd((e) => (e.density = v), 'density') })
          : null,
      ),
      h(
        'div',
        { class: 'row' },
        button('Duplicate', () => {
          const copy = { ...structuredClone(el), id: uid('el'), name: `${el.name} copy`, position: [el.position[0] + 2, el.position[1], el.position[2]] as Vec3 };
          store.edit((s) => s.stage.elements.push(copy));
          store.setSel({ element: copy.id });
        }),
        button(
          'Delete',
          () => {
            store.edit((s) => (s.stage.elements = s.stage.elements.filter((e) => e.id !== id)));
            store.setSel({ element: null });
          },
          { class: 'btn danger' },
        ),
      ),
    ];
  }

  function fixtureInspector(f: Fixture) {
    const id = f.id;
    const upd = (fn: (x: Fixture) => void, key: string) =>
      edit((s) => {
        const x = s.fixtures.find((y) => y.id === id);
        if (x) fn(x);
      }, `${id}-${key}`);
    return [
      h('div', { class: 'panel-head' }, h('h2', null, `✦ ${f.name}`)),
      section(
        'Laser',
        textInput({ label: 'Name', value: f.name, onChange: (v) => upd((x) => (x.name = v), 'name') }),
        textInput({ label: 'Group', value: f.group, onChange: (v) => upd((x) => (x.group = v || 'Lasers'), 'group') }),
        vec3Input('Position (m)', f.position, (v) => upd((x) => (x.position = v), 'pos')),
        slider({ label: 'Aim left/right', value: f.aim[0], min: -180, max: 180, unit: '°', onInput: (v) => upd((x) => (x.aim = [v, x.aim[1]]), 'yaw') }),
        slider({ label: 'Aim up/down', value: f.aim[1], min: -90, max: 90, unit: '°', onInput: (v) => upd((x) => (x.aim = [x.aim[0], v]), 'pitch') }),
      ),
      section(
        'Projector',
        slider({ label: 'Scan angle', value: f.scanAngle, min: 10, max: 180, unit: '°', onInput: (v) => upd((x) => (x.scanAngle = v), 'scan') }),
        slider({ label: 'Max beams', value: f.maxBeams, min: 1, max: 128, onInput: (v) => upd((x) => (x.maxBeams = v), 'beams') }),
        slider({ label: 'Power', value: f.power, min: 0.05, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => upd((x) => (x.power = v), 'power') }),
      ),
      section(
        'Output patch',
        numberInput({ label: 'Art-Net universe', value: f.dmx.universe, step: 1, min: 0, max: 32767, onChange: (v) => upd((x) => (x.dmx = { ...x.dmx, universe: Math.round(v) }), 'uni') }),
        numberInput({ label: 'DMX address', value: f.dmx.address, step: 1, min: 1, max: 503, onChange: (v) => upd((x) => (x.dmx = { ...x.dmx, address: clamp(Math.round(v), 1, 503) }), 'addr') }),
        textInput({ label: 'Ether Dream IP', value: f.dac ?? '', placeholder: 'e.g. 192.168.1.50', onChange: (v) => upd((x) => (x.dac = v.trim() || undefined), 'dac') }),
      ),
      h(
        'div',
        { class: 'row' },
        button('Duplicate', () => {
          const copy = { ...structuredClone(f), id: uid('fx'), name: `${f.name} copy`, position: [-f.position[0] || f.position[0] + 2, f.position[1], f.position[2]] as Vec3, aim: [-f.aim[0], f.aim[1]] as [number, number] };
          copy.dmx = { ...f.dmx, address: Math.min(503, Math.max(0, ...store.show.fixtures.map((x) => x.dmx.address + 9)) + 1) };
          store.edit((s) => {
            s.fixtures.push(copy);
            // Give the copy the same look as the original in every cue.
            for (const c of s.cues) if (c.looks[f.id]) c.looks[copy.id] = structuredClone(c.looks[f.id]);
          });
          store.setSel({ element: copy.id });
        }, { title: 'Mirrored copy on the other side of the stage' }),
        button(
          'Delete',
          () => {
            store.edit((s) => {
              s.fixtures = s.fixtures.filter((x) => x.id !== id);
              for (const c of s.cues) delete c.looks[id];
            });
            store.setSel({ element: null });
            store.pruneSelection();
          },
          { class: 'btn danger' },
        ),
      ),
    ];
  }

  const render = () => {
    const item = findItem(store.show, store.sel.element);
    clear(root, ...(item ? (item.kind === 'element' ? elementInspector(item.el) : fixtureInspector(item.f)) : stageSettings()));
    if (item) root.append(h('div', { class: 'row' }, button('← Venue settings', () => store.setSel({ element: null }), { class: 'btn btn-sm' })));
  };
  render();
  store.subscribe((c) => {
    if (c.source === 'inspector') return;
    if (c.topics.has('sel') || c.topics.has('show')) render();
  });
}

/** Top-down floor plan. Drag elements/lasers; wheel to zoom; right-drag to pan. */
export function mountPlanView(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const canvas = h('canvas', { class: 'plan-canvas' });
  root.append(h('div', { class: 'plan-head' }, h('h2', null, 'Floor plan'), h('span', { class: 'hint' }, 'Drag to move (snaps to 0.5 m, hold Alt for free) · wheel to zoom · right-drag to pan · audience is at the bottom')), canvas);
  const ctx = canvas.getContext('2d')!;
  let scale = 8; // px per metre
  let cx = 0;
  let cz = 0;
  let fitted = -1;
  let drag: { id: string; dx: number; dz: number } | null = null;
  let pan: { x: number; y: number; cx: number; cz: number } | null = null;
  let planDrag = 0;

  const toScreen = (x: number, z: number) => [canvas.clientWidth / 2 + (x - cx) * scale, canvas.clientHeight / 2 + (z - cz) * scale];
  const toWorld = (sx: number, sy: number) => [(sx - canvas.clientWidth / 2) / scale + cx, (sy - canvas.clientHeight / 2) / scale + cz];

  function fit() {
    const els = store.show.stage.elements.filter((e) => e.kind !== 'floor');
    const xs = [...els.flatMap((e) => [e.position[0] - e.size[0] / 2, e.position[0] + e.size[0] / 2]), ...store.show.fixtures.map((f) => f.position[0])];
    const zs = [...els.flatMap((e) => [e.position[2] - e.size[2] / 2, e.position[2] + e.size[2] / 2]), ...store.show.fixtures.map((f) => f.position[2])];
    if (!xs.length) return;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    cx = (minX + maxX) / 2;
    cz = (minZ + maxZ) / 2;
    scale = Math.min((canvas.clientWidth - 40) / Math.max(4, maxX - minX), (canvas.clientHeight - 30) / Math.max(4, maxZ - minZ));
  }

  function pick(sx: number, sy: number): string | null {
    const [wx, wz] = toWorld(sx, sy);
    for (const f of store.show.fixtures) {
      const [fx, fy] = toScreen(f.position[0], f.position[2]);
      if (Math.hypot(fx - sx, fy - sy) < 9) return f.id;
    }
    // Topmost (last drawn, smallest) element first; floor last.
    const els = [...store.show.stage.elements].sort((a, b) => a.size[0] * a.size[2] - b.size[0] * b.size[2]);
    for (const el of els) {
      const a = -rad(el.rotation);
      const dx = wx - el.position[0];
      const dz = wz - el.position[2];
      const lx = dx * Math.cos(a) - dz * Math.sin(a);
      const lz = dx * Math.sin(a) + dz * Math.cos(a);
      if (Math.abs(lx) <= el.size[0] / 2 && Math.abs(lz) <= el.size[2] / 2) return el.id;
    }
    return null;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.button === 2 || e.button === 1) {
      pan = { x: sx, y: sy, cx, cz };
      return;
    }
    const id = pick(sx, sy);
    store.setSel({ element: id });
    const item = findItem(store.show, id);
    if (!item || (item.kind === 'element' && item.el.kind === 'floor')) return;
    const p = item.kind === 'element' ? item.el.position : item.f.position;
    const [wx, wz] = toWorld(sx, sy);
    planDrag++;
    drag = { id: id!, dx: p[0] - wx, dz: p[2] - wz };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (pan) {
      cx = pan.cx - (sx - pan.x) / scale;
      cz = pan.cz - (sy - pan.y) / scale;
      return;
    }
    if (!drag) return;
    const [wx, wz] = toWorld(sx, sy);
    const snap = (v: number) => (e.altKey ? Math.round(v * 100) / 100 : Math.round(v * 2) / 2);
    const nx = snap(wx + drag.dx);
    const nz = snap(wz + drag.dz);
    const d = drag;
    store.edit(
      (s) => {
        const el = s.stage.elements.find((x) => x.id === d.id);
        if (el) el.position = [nx, el.position[1], nz];
        const f = s.fixtures.find((x) => x.id === d.id);
        if (f) f.position = [nx, f.position[1], nz];
      },
      { coalesce: `plan-${d.id}-${planDrag}`, source: 'plan', gesture: true },
    );
  });
  const end = () => {
    if (drag) store.emit('show'); // let the lists/inspector catch up
    drag = null;
    pan = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      scale = clamp(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 120);
    },
    { passive: false },
  );

  function draw() {
    requestAnimationFrame(draw);
    if (store.mode !== 'stage') return;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    if (fitted !== store.generation) {
      fit();
      fitted = store.generation;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#090b11';
    ctx.fillRect(0, 0, w, hgt);
    // 1 m grid, 5 m major.
    const [x0, z0] = toWorld(0, 0);
    const [x1, z1] = toWorld(w, hgt);
    for (let x = Math.floor(x0); x <= x1; x++) {
      const [sx] = toScreen(x, 0);
      if (scale < 4 && x % 5) continue;
      ctx.strokeStyle = x % 5 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, hgt);
      ctx.stroke();
    }
    for (let z = Math.floor(z0); z <= z1; z++) {
      const [, sy] = toScreen(0, z);
      if (scale < 4 && z % 5) continue;
      ctx.strokeStyle = z % 5 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(w, Math.round(sy) + 0.5);
      ctx.stroke();
    }
    const sel = store.sel.element;
    const els = [...store.show.stage.elements].sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2]);
    ctx.font = '11px system-ui, sans-serif';
    for (const el of els) {
      const [sx, sy] = toScreen(el.position[0], el.position[2]);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-rad(el.rotation));
      const ew = el.size[0] * scale;
      const ed = el.size[2] * scale;
      ctx.fillStyle = PLAN_COLORS[el.kind];
      ctx.globalAlpha = el.kind === 'crowd' ? 0.45 : 0.9;
      ctx.fillRect(-ew / 2, -ed / 2, ew, Math.max(2, ed));
      ctx.globalAlpha = 1;
      if (el.id === sel) {
        ctx.strokeStyle = '#4cc9f0';
        ctx.lineWidth = 2;
        ctx.strokeRect(-ew / 2, -ed / 2, ew, Math.max(2, ed));
      }
      ctx.restore();
      if (el.kind !== 'floor' && ew > 40) {
        ctx.fillStyle = 'rgba(232,236,255,0.75)';
        ctx.fillText(el.name, sx - ctx.measureText(el.name).width / 2, sy + 4);
      }
    }
    for (const f of store.show.fixtures) {
      const [sx, sy] = toScreen(f.position[0], f.position[2]);
      const yaw = rad(f.aim[0]);
      // Aim indicator: +z (towards the audience) is down on screen.
      ctx.strokeStyle = 'rgba(0,255,120,0.5)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.sin(yaw) * 26, sy + Math.cos(yaw) * 26);
      ctx.stroke();
      ctx.fillStyle = f.id === sel ? '#4cc9f0' : '#00ff78';
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#7f8bb3';
    ctx.fillText('▼ audience', 8, hgt - 8);
    ctx.fillText(`${(100 / scale).toFixed(1)} m / 100 px`, w - 100, hgt - 8);
  }
  draw();
}

/** Floating tool bar over the 3D view in Stage mode: move / rotate / scale and friends. */
export function mountStageTools(viewportEl: HTMLElement, studio: Studio) {
  const { store } = studio;
  const bar = h('div', { class: 'stage-tools', role: 'toolbar', 'aria-label': 'Stage tools' });
  viewportEl.appendChild(bar);
  const tools: { mode: GizmoMode; label: string; icon: string; key: string; hint: string }[] = [
    { mode: 'translate', label: 'Move', icon: '✥', key: 'G', hint: 'Drag the arrows — or grab any object and drag it along the floor (Shift-drag to lift)' },
    { mode: 'rotate', label: 'Rotate', icon: '⟳', key: 'R', hint: 'Turn objects; on lasers it changes the aim (left/right and up/down)' },
    { mode: 'scale', label: 'Scale', icon: '⤢', key: 'C', hint: 'Resize objects (mirror balls stay round)' },
  ];
  const render = () => {
    bar.hidden = store.mode !== 'stage';
    if (bar.hidden) return;
    const vp = studio.viewport;
    const sel = store.sel.element;
    const isFixture = store.show.fixtures.some((f) => f.id === sel);
    clear(
      bar,
      ...tools.map((t) =>
        h(
          'button',
          {
            class: `tool ${studio.stageTool === t.mode ? 'active' : ''}`,
            title: `${t.label} (${t.key}) — ${t.hint}`,
            disabled: t.mode === 'scale' && isFixture,
            onclick: () => studio.setStageTool(t.mode),
          },
          h('span', { class: 'tool-icon' }, t.icon),
          h('span', { class: 'tool-label' }, t.label),
          h('kbd', null, t.key),
        ),
      ),
      h('span', { class: 'tool-sep' }),
      h(
        'button',
        { class: `tool ${vp?.gizmoSnap ? 'active' : ''}`, title: 'Snap to 0.5 m / 15° / 10% steps (hold Alt while dragging for free movement)', onclick: () => studio.setStageSnap(!vp?.gizmoSnap) },
        h('span', { class: 'tool-icon' }, '⌗'),
        h('span', { class: 'tool-label' }, 'Snap'),
      ),
      h('button', { class: 'tool', title: 'Focus the camera on the selection (F)', disabled: !sel, onclick: () => sel && vp?.focus(sel) }, h('span', { class: 'tool-icon' }, '◎'), h('span', { class: 'tool-label' }, 'Focus'), h('kbd', null, 'F')),
      h('button', { class: 'tool', title: 'Duplicate (Ctrl+D)', disabled: !sel, onclick: () => studio.duplicateStageItem() }, h('span', { class: 'tool-icon' }, '⧉'), h('span', { class: 'tool-label' }, 'Duplicate')),
      h('button', { class: 'tool danger', title: 'Delete (Del)', disabled: !sel, onclick: () => studio.deleteStageItem() }, h('span', { class: 'tool-icon' }, '✕'), h('span', { class: 'tool-label' }, 'Delete')),
      h('span', { class: 'tool-hint' }, 'Camera: WASD move · Q/E turn · Z/X look · drag to orbit · right-drag to pan · wheel to zoom'),
    );
  };
  render();
  store.subscribe((c) => (c.topics.has('mode') || c.topics.has('sel') || c.topics.has('show')) && render());
}
