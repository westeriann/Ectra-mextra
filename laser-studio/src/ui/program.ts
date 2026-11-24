// Program mode: fixture list (left), effect editor (right), cue list + pads (bottom).

import { COLOR_MODES, EFFECT_KINDS, type Effect, type EffectKind, type Pad } from '../core/types';
import { uid } from '../core/util';
import { button, clear, colorInput, h, modal, section, select, slider, textInput, toggle } from './dom';
import type { Studio } from './studio';

const EFFECT_LABELS: Record<EffectKind, string> = {
  static: 'Static fan',
  fan: 'Fan',
  sweep: 'Sweep',
  crossfan: 'Crossfan',
  wave: 'Wave',
  chase: 'Chase',
  cone: 'Cone',
  tunnel: 'Tunnel',
  sheet: 'Sheet',
  spiral: 'Spiral',
  scatter: 'Scatter',
  shape: 'Shape',
};

const SPEEDS = [
  { v: 0.0625, l: '1/16' },
  { v: 0.125, l: '1/8' },
  { v: 0.25, l: '1/4' },
  { v: 0.5, l: '1/2' },
  { v: 1, l: '1' },
  { v: 2, l: '2' },
  { v: 4, l: '4' },
];

const SWATCHES = ['#ff0010', '#ff6000', '#ffd000', '#00ff40', '#00ffd0', '#0080ff', '#2020ff', '#8000ff', '#ff00c8', '#ffffff'];

export function mountFixtureList(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const render = () => {
    const sel = new Set(store.sel.fixtures);
    const groups = new Map<string, typeof store.show.fixtures>();
    for (const f of store.show.fixtures) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group)!.push(f);
    }
    const prog = store.live.programmer ?? {};
    clear(
      root,
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, 'Lasers'),
        h(
          'div',
          { class: 'row' },
          button('All', () => store.setSel({ fixtures: store.show.fixtures.map((f) => f.id) }), { class: 'btn btn-sm' }),
          button('None', () => store.setSel({ fixtures: [] }), { class: 'btn btn-sm' }),
        ),
      ),
      h('p', { class: 'hint' }, 'Click to select, Shift/Ctrl-click to add. You can also click lasers in the 3D view.'),
      ...[...groups].map(([group, fixtures]) =>
        h(
          'div',
          { class: 'fx-group' },
          h(
            'button',
            {
              class: 'fx-group-name',
              title: 'Select this group',
              onclick: (e: MouseEvent) => {
                const ids = fixtures.map((f) => f.id);
                store.setSel({ fixtures: e.shiftKey ? [...new Set([...store.sel.fixtures, ...ids])] : ids });
              },
            },
            group,
            h('span', { class: 'count' }, String(fixtures.length)),
          ),
          ...fixtures.map((f) =>
            h(
              'button',
              {
                class: `fx-item ${sel.has(f.id) ? 'selected' : ''}`,
                onclick: (e: MouseEvent) => {
                  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                  const next = additive ? (sel.has(f.id) ? store.sel.fixtures.filter((x) => x !== f.id) : [...store.sel.fixtures, f.id]) : [f.id];
                  store.setSel({ fixtures: next });
                },
              },
              h('span', { class: `dot ${prog[f.id] ? 'prog' : ''}`, title: prog[f.id] ? 'Has unsaved programmer changes' : '' }),
              f.name,
            ),
          ),
        ),
      ),
    );
  };
  render();
  store.subscribe((c) => {
    if (c.topics.has('sel') || c.topics.has('show') || c.topics.has('live')) render();
  });
}

export function mountEffectEditor(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const render = () => {
    const ids = store.sel.fixtures;
    const editingCue = store.show.cues.find((c) => c.id === store.sel.cueId);
    const hasProg = !!store.live.programmer;
    const actions = h(
      'div',
      { class: 'prog-actions' },
      button('Record new cue', () => studio.recordCue(), { class: 'btn btn-primary', title: 'Save what is on stage as a new cue (R)' }),
      button(editingCue ? `Update “${editingCue.name}”` : 'Update cue', () => studio.updateCue(), { disabled: !editingCue || !hasProg, title: 'Write your changes into the cue being edited' }),
      button('Clear', () => studio.clearProgrammer(), { disabled: !hasProg, title: 'Discard programmer changes (Esc)' }),
    );
    if (!ids.length) {
      clear(
        root,
        h('div', { class: 'panel-head' }, h('h2', null, 'Look')),
        h('div', { class: 'empty' }, h('p', null, 'Select lasers on the left (or click them in the 3D view) to give them an effect.'), h('p', null, 'Then record the look as a cue.')),
        actions,
      );
      return;
    }
    const look = studio.currentLook(ids[0]);
    const e = look.effect;
    const set = (patch: Partial<Effect> & { on?: boolean }, rerender = false) => {
      studio.program(patch);
      if (rerender) render();
    };
    const kindGrid = h(
      'div',
      { class: 'kind-grid' },
      ...EFFECT_KINDS.map((k) => h('button', { class: `kind ${e.kind === k ? 'active' : ''}`, onclick: () => set({ kind: k }, true) }, EFFECT_LABELS[k])),
    );
    const speedRow = h(
      'div',
      { class: 'speed-row' },
      ...(e.sync
        ? SPEEDS.map((s) => h('button', { class: `chip ${Math.abs(e.speed - s.v) < 1e-6 ? 'active' : ''}`, title: `${s.l} cycle per beat`, onclick: () => set({ speed: s.v }, true) }, s.l))
        : []),
    );
    const shapes = store.show.shapes;
    clear(
      root,
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, ids.length === 1 ? store.show.fixtures.find((f) => f.id === ids[0])?.name ?? 'Look' : `${ids.length} lasers`),
        toggle({ label: 'On', value: look.on, onChange: (v) => set({ on: v }) }),
      ),
      editingCue ? h('p', { class: 'hint editing' }, `Editing cue: ${editingCue.name}`) : null,
      section('Effect', kindGrid, e.kind === 'shape' ? select({ label: 'Shape', value: e.shapeId ?? '', options: [{ value: '', label: '(spinning triangle)' }, ...shapes.map((s) => ({ value: s.id, label: s.name }))], onChange: (v) => set({ shapeId: v || undefined }) }) : null),
      section(
        'Movement',
        slider({ label: 'Beams', value: e.beams, min: 1, max: 64, onInput: (v) => set({ beams: v }) }),
        slider({ label: 'Spread', value: e.spread, min: 0, max: 180, unit: '°', onInput: (v) => set({ spread: v }) }),
        slider({ label: 'Size', value: e.size, min: 0, max: 60, unit: '°', onInput: (v) => set({ size: v }) }),
        slider({ label: 'Pan', value: e.pan, min: -90, max: 90, unit: '°', onInput: (v) => set({ pan: v }) }),
        slider({ label: 'Tilt', value: e.tilt, min: -60, max: 60, unit: '°', onInput: (v) => set({ tilt: v }) }),
        toggle({ label: 'Sync speed to beat', value: e.sync, onChange: (v) => set({ sync: v, speed: v ? 0.25 : 0.5 }, true) }),
        e.sync
          ? h('div', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Cycles / beat'), speedRow)
          : slider({ label: 'Speed', value: e.speed, min: 0, max: 4, step: 0.01, unit: ' Hz', onInput: (v) => set({ speed: v }) }),
        slider({ label: 'Phase spread', value: e.phaseSpread, min: 0, max: 1, step: 0.01, title: 'Offsets the movement between lasers — makes chases across the rig', onInput: (v) => set({ phaseSpread: v }) }),
        toggle({ label: 'Mirror left/right', value: e.mirror, onChange: (v) => set({ mirror: v }) }),
      ),
      section(
        'Colour',
        h(
          'div',
          { class: 'swatches' },
          ...SWATCHES.map((c) => h('button', { class: 'swatch', style: `background:${c}`, title: c, onclick: () => set({ color: c, colorMode: e.colorMode === 'rainbow' ? 'solid' : e.colorMode }, true) })),
        ),
        select({ label: 'Mode', value: e.colorMode, options: COLOR_MODES, onChange: (v) => set({ colorMode: v }, true) }),
        colorInput({ label: 'Colour', value: e.color, onInput: (v) => set({ color: v }) }),
        e.colorMode === 'alternate' || e.colorMode === 'gradient' ? colorInput({ label: 'Colour 2', value: e.color2, onInput: (v) => set({ color2: v }) }) : null,
      ),
      section(
        'Intensity',
        slider({ label: 'Intensity', value: e.intensity, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set({ intensity: v }) }),
        slider({ label: e.sync ? 'Strobe / beat' : 'Strobe Hz', value: e.strobe, min: 0, max: 16, step: e.sync ? 0.5 : 0.5, onInput: (v) => set({ strobe: v }) }),
        slider({ label: 'Audio react', value: e.audioReact, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, title: 'Pulse brightness with the music (or microphone)', onInput: (v) => set({ audioReact: v }) }),
      ),
      actions,
    );
  };
  render();
  store.subscribe((c) => {
    // The editor's own slider drags come back as 'programmer'; don't rebuild under the mouse.
    if (c.source === 'programmer') return;
    if (c.topics.has('sel') || c.topics.has('show') || c.topics.has('live')) render();
  });
}

export function mountCueList(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const list = h('div', { class: 'cue-list' });
  const pads = h('div', { class: 'pads' });
  let dragId: string | null = null;

  async function rename(id: string) {
    const cue = store.show.cues.find((c) => c.id === id);
    if (!cue) return;
    let name = cue.name;
    let fade = cue.fade;
    let tag = cue.tag;
    const ok = await modal(
      'Cue settings',
      h(
        'div',
        { class: 'form' },
        textInput({ label: 'Name', value: name, onChange: (v) => (name = v) }),
        slider({ label: 'Fade in', value: fade, min: 0, max: 10, step: 0.1, unit: 's', onInput: (v) => (fade = v) }),
        colorInput({ label: 'Tag colour', value: tag, onInput: (v) => (tag = v) }),
      ),
      [
        { label: 'Cancel', value: false },
        { label: 'Apply', value: true, primary: true },
      ],
    );
    if (ok) {
      store.edit((s) => {
        const c = s.cues.find((x) => x.id === id);
        if (c) Object.assign(c, { name: name.trim() || c.name, fade, tag });
      });
    }
  }

  function renderList() {
    const active = studio.frame.activeCueId ?? store.live.cueId;
    clear(
      list,
      ...store.show.cues.map((cue, i) =>
        h(
          'div',
          {
            class: `cue ${active === cue.id ? 'live' : ''} ${store.sel.cueId === cue.id ? 'editing' : ''}`,
            style: `--tag:${cue.tag}`,
            draggable: 'true',
            ondragstart: (e: DragEvent) => {
              dragId = cue.id;
              e.dataTransfer?.setData('text/plain', cue.id);
            },
            ondragover: (e: DragEvent) => e.preventDefault(),
            ondrop: (e: DragEvent) => {
              e.preventDefault();
              if (!dragId || dragId === cue.id) return;
              const from = dragId;
              store.edit((s) => {
                const fi = s.cues.findIndex((c) => c.id === from);
                const [moved] = s.cues.splice(fi, 1);
                s.cues.splice(s.cues.findIndex((c) => c.id === cue.id), 0, moved);
              });
            },
          },
          h(
            'button',
            { class: 'cue-go', title: 'Go to this cue', onclick: () => studio.goCueById(cue.id) },
            h('span', { class: 'cue-num' }, String(i + 1)),
            h('span', { class: 'cue-name' }, cue.name),
            h('span', { class: 'cue-fade' }, `${cue.fade}s`),
          ),
          h(
            'div',
            { class: 'cue-tools' },
            button('Edit', () => studio.editCue(cue.id), { class: 'btn btn-xs', title: 'Load into the editor' }),
            button('⚙', () => rename(cue.id), { class: 'btn btn-xs', title: 'Name, fade, colour' }),
            button('⧉', () => store.edit((s) => s.cues.splice(i + 1, 0, { ...structuredClone(cue), id: uid('cue'), name: `${cue.name} copy` })), { class: 'btn btn-xs', title: 'Duplicate' }),
            button(
              '✕',
              async () => {
                const used = store.show.timeline.cues.filter((t) => t.cueId === cue.id).length;
                if (used) {
                  const ok = await modal('Delete cue?', `“${cue.name}” is used ${used} time(s) on the timeline. Those entries will be removed too.`, [
                    { label: 'Cancel', value: false },
                    { label: 'Delete', value: true, primary: true },
                  ]);
                  if (!ok) return;
                }
                store.edit((s) => {
                  s.cues = s.cues.filter((c) => c.id !== cue.id);
                  s.timeline.cues = s.timeline.cues.filter((t) => t.cueId !== cue.id);
                  s.pads.forEach((p) => p.cueId === cue.id && (p.cueId = null));
                });
                store.pruneSelection();
              },
              { class: 'btn btn-xs danger', title: 'Delete' },
            ),
          ),
        ),
      ),
    );
  }

  async function editPad(pad: Pad) {
    let { label, cueId, mode, key } = pad;
    const ok = await modal(
      'Flash pad',
      h(
        'div',
        { class: 'form' },
        textInput({ label: 'Label', value: label, onChange: (v) => (label = v) }),
        select({ label: 'Cue', value: cueId ?? '', options: [{ value: '', label: '(none)' }, ...store.show.cues.map((c) => ({ value: c.id, label: c.name }))], onChange: (v) => (cueId = v || null) }),
        select({ label: 'Mode', value: mode, options: [{ value: 'flash', label: 'Flash (hold)' }, { value: 'toggle', label: 'Toggle (latch)' }], onChange: (v) => (mode = v) }),
        textInput({ label: 'Key', value: key, onChange: (v) => (key = v.slice(0, 1).toLowerCase()) }),
      ),
      [
        { label: 'Cancel', value: false },
        { label: 'Apply', value: true, primary: true },
      ],
    );
    if (ok) store.edit((s) => Object.assign(s.pads.find((p) => p.id === pad.id)!, { label, cueId, mode, key }));
  }

  function renderPads() {
    const active = new Set(store.live.activePads);
    clear(
      pads,
      ...store.show.pads.map((pad) => {
        const cue = store.show.cues.find((c) => c.id === pad.cueId);
        const el = h(
          'button',
          {
            class: `pad ${active.has(pad.id) ? 'on' : ''} ${pad.mode}`,
            style: `--tag:${cue?.tag ?? '#555'}`,
            title: `${pad.mode === 'flash' ? 'Hold' : 'Click'} to fire • right-click to edit • key ${pad.key.toUpperCase()}`,
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              void editPad(pad);
            },
          },
          h('span', { class: 'pad-key' }, pad.key.toUpperCase()),
          h('span', { class: 'pad-label' }, pad.label),
        );
        el.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          el.setPointerCapture(e.pointerId);
          studio.padDown(pad.id);
        });
        el.addEventListener('pointerup', () => studio.padUp(pad.id));
        el.addEventListener('pointercancel', () => studio.padUp(pad.id));
        return el;
      }),
    );
  }

  root.append(
    h(
      'div',
      { class: 'cues-col' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, 'Cues'),
        h(
          'div',
          { class: 'row' },
          button('◀ Back', () => studio.back(), { class: 'btn', title: 'Previous cue' }),
          button('GO ▶', () => studio.go(), { class: 'btn btn-go', title: 'Next cue (Enter)' }),
          button('Release', () => studio.release(), { class: 'btn', title: 'Fade everything out' }),
        ),
      ),
      list,
    ),
    h('div', { class: 'pads-col' }, h('div', { class: 'panel-head' }, h('h2', null, 'Flash pads'), h('span', { class: 'hint' }, 'Hold to fire · right-click to assign')), pads),
  );
  renderList();
  renderPads();
  let lastActive: string | null = null;
  store.subscribe((c) => {
    if (c.topics.has('show') || c.topics.has('live') || c.topics.has('sel')) {
      renderList();
      renderPads();
    }
  });
  // The timeline can change the active cue without a store event.
  setInterval(() => {
    const a = studio.frame.activeCueId;
    if (a !== lastActive) {
      lastActive = a;
      renderList();
    }
  }, 100);
}
