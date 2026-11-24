import { STAGE_TEMPLATES } from '../core/stages';
import { fmtTime } from '../core/util';
import { openOutputWindow, setWindowTitle } from '../platform/bridge';
import { CAMERA_PRESETS, type CameraPreset } from '../render/viewport';
import { button, clear, h, modal } from './dom';
import { startTour } from './tour';
import type { Mode } from './store';
import type { Studio } from './studio';

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'program', label: 'Program', hint: 'Build looks and cues, busk live' },
  { id: 'show', label: 'Show', hint: 'Sync cues to music on a timeline' },
  { id: 'stage', label: 'Stage', hint: 'Design the venue and place lasers' },
  { id: 'setup', label: 'Setup', hint: 'Art-Net, OSC, MIDI, laser DACs' },
];

export function mountTopbar(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const time = h('span', { class: 'tb-time' }, '0:00.0');
  const bpm = h('span', { class: 'tb-bpm' });
  const beatDot = h('span', { class: 'beat-dot' });
  const fileLabel = h('span', { class: 'tb-file' });
  const tabs = h('nav', { class: 'tabs', role: 'tablist' });
  const playBtn = button('▶', () => studio.togglePlay(), { class: 'btn btn-icon', title: 'Play / pause (Space)' });
  const recBtn = button('● REC', () => studio.toggleRecording(), { class: 'btn btn-rec', title: 'Record the viewport to a video file' });
  const blackout = button('Blackout', () => studio.toggleBlackout(), { class: 'btn btn-blackout', title: 'Blackout (B)' });
  const master = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.01',
    value: String(store.live.master),
    title: 'Master intensity',
    oninput: (e: Event) => studio.setMaster(Number((e.target as HTMLInputElement).value)),
  });
  const undoBtn = button('↶', () => store.undo(), { class: 'btn btn-icon', title: 'Undo (Ctrl+Z)' });
  const redoBtn = button('↷', () => store.redo(), { class: 'btn btn-icon', title: 'Redo (Ctrl+Shift+Z)' });

  const camSelect = h(
    'select',
    { title: 'Camera', onchange: (e: Event) => studio.setCamera((e.target as HTMLSelectElement).value as CameraPreset) },
    ...CAMERA_PRESETS.map((c) => h('option', { value: c.id }, `${c.label} (${c.key})`)),
  );

  async function chooseTemplate() {
    let picked = STAGE_TEMPLATES[1].id;
    const list = h(
      'div',
      { class: 'template-list' },
      ...STAGE_TEMPLATES.map((t) =>
        h(
          'label',
          { class: 'template' },
          h('input', { type: 'radio', name: 'tpl', value: t.id, checked: t.id === picked, onchange: () => (picked = t.id) }),
          h('div', null, h('strong', null, t.name), h('p', null, t.description)),
        ),
      ),
    );
    const ok = await modal('New show', list, [
      { label: 'Cancel', value: false },
      { label: 'Create', value: true, primary: true },
    ]);
    if (ok) await studio.newShow(picked);
  }

  const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
  const item = (label: string, kbd: string, fn: () => void) =>
    h('button', { class: 'menu-item', role: 'menuitem', onclick: () => ((menu.hidden = true), fn()) }, h('span', null, label), h('kbd', null, kbd));
  menu.append(
    item('New show…', '', chooseTemplate),
    item('Open…', 'Ctrl+O', () => studio.open()),
    item('Save', 'Ctrl+S', () => studio.save()),
    item('Save as…', 'Ctrl+Shift+S', () => studio.save(true)),
    h('hr'),
    item('Load music…', '', () => studio.loadMusic()),
    item('Import ILDA shape…', '', () => studio.importIlda()),
    h('hr'),
    item('Tutorial', '', () => startTour(studio)),
    item('Keyboard shortcuts', '?', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))),
  );
  const fileBtn = button('File ▾', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  }, { class: 'btn', title: 'New, open, save, import' });
  document.addEventListener('click', (e) => !menu.contains(e.target as Node) && (menu.hidden = true));

  root.append(
    h(
      'div',
      { class: 'tb-left' },
      h('div', { class: 'logo', title: 'Laser Studio' }, h('span', { class: 'logo-mark' }), h('span', { class: 'logo-text' }, 'Laser Studio')),
      h('div', { class: 'menu-wrap' }, fileBtn, menu),
      h('div', { class: 'tb-group' }, undoBtn, redoBtn),
      tabs,
      fileLabel,
    ),
    h(
      'div',
      { class: 'tb-right' },
      h(
        'div',
        { class: 'transport' },
        button('■', () => studio.stopTransport(), { class: 'btn btn-icon', title: 'Stop' }),
        playBtn,
        time,
        h('span', { class: 'tb-tempo' }, beatDot, bpm),
        button('Tap', () => studio.tap(), { class: 'btn', title: 'Tap tempo (T) — used when no song is loaded' }),
      ),
      h('label', { class: 'master', title: 'Master intensity' }, 'Master', master),
      blackout,
      camSelect,
      recBtn,
      button('Output ⧉', () => openOutputWindow(), { title: 'Open a fullscreen output window (for a projector or second screen)' }),
    ),
  );

  function renderTabs() {
    clear(
      tabs,
      ...MODES.map((m) =>
        h(
          'button',
          { class: `tab ${store.mode === m.id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(store.mode === m.id), title: m.hint, onclick: () => store.setMode(m.id) },
          m.label,
        ),
      ),
    );
  }

  function renderFile() {
    const name = `${store.fileName}${store.dirty ? ' •' : ''}`;
    fileLabel.textContent = name;
    void setWindowTitle(`${name} — Laser Studio`);
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  }

  function renderLive() {
    blackout.classList.toggle('on', store.live.blackout);
    if (document.activeElement !== master) master.value = String(store.live.master);
  }

  renderTabs();
  renderFile();
  renderLive();
  store.subscribe((c) => {
    if (c.topics.has('mode')) renderTabs();
    if (c.topics.has('file') || c.topics.has('show')) renderFile();
    if (c.topics.has('live')) renderLive();
  });

  // Fast-changing readouts update every frame without touching the store.
  let lastBeat = -1;
  const tick = () => {
    requestAnimationFrame(tick);
    const t = studio.songTime;
    time.textContent = t === null ? '--:--.-' : `${fmtTime(t)} / ${fmtTime(studio.audio.duration)}`;
    bpm.textContent = `${studio.bpm.toFixed(1)} BPM`;
    const beat = Math.floor(studio.frame.beat);
    if (beat !== lastBeat) {
      lastBeat = beat;
      beatDot.classList.remove('hit');
      void beatDot.offsetWidth;
      beatDot.classList.add('hit');
    }
    playBtn.textContent = studio.audio.playing ? '❚❚' : '▶';
    recBtn.classList.toggle('on', !!studio.viewport?.recording);
  };
  tick();
}
