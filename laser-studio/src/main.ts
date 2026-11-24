import './styles/app.css';
import { isDesktop, onBroadcast, startupFile } from './platform/bridge';
import { CAMERA_PRESETS } from './render/viewport';
import { h, modal, toast } from './ui/dom';
import { mountOutputView } from './ui/output-view';
import { Outputs } from './ui/outputs';
import { mountCueList, mountEffectEditor, mountFixtureList } from './ui/program';
import { mountSetup } from './ui/setup';
import { mountPlanView, mountStageInspector, mountStageList } from './ui/stage-editor';
import { Store } from './ui/store';
import { Studio } from './ui/studio';
import { startTour, tourDone } from './ui/tour';
import { mountCuePalette, mountMusicPanel, mountTimeline } from './ui/timeline';
import { mountTopbar } from './ui/topbar';

const app = document.getElementById('app')!;

if (new URLSearchParams(location.search).get('view') === 'output') {
  mountOutputView(app);
} else {
  void startEditor();
}

async function startEditor() {
  const store = new Store();
  const studio = new Studio(store);

  // Layout.
  const topbar = h('header', { class: 'topbar' });
  const left = h('aside', { class: 'side left' });
  const right = h('aside', { class: 'side right' });
  const viewport = h('main', { class: 'viewport' });
  const hud = h('div', { class: 'hud' });
  const bottom = h('footer', { class: 'bottom' });
  viewport.append(hud);
  app.append(h('div', { class: 'shell' }, topbar, left, viewport, right, bottom));

  // Each mode has its own panels in the same slots; only the active ones show.
  const slot = (parent: HTMLElement, mode: string) => parent.appendChild(h('div', { class: 'slot', dataset: { mode } }));
  studio.start(viewport);
  const outputs = new Outputs(studio);
  mountTopbar(topbar, studio);
  mountFixtureList(slot(left, 'program'), studio);
  mountEffectEditor(slot(right, 'program'), studio);
  mountCueList(slot(bottom, 'program'), studio);
  mountCuePalette(slot(left, 'show'), studio);
  mountMusicPanel(slot(right, 'show'), studio);
  mountTimeline(slot(bottom, 'show'), studio);
  mountStageList(slot(left, 'stage'), studio);
  mountStageInspector(slot(right, 'stage'), studio);
  mountPlanView(slot(bottom, 'stage'), studio);
  mountSetup(slot(right, 'setup'), studio, outputs);

  const applyMode = () => {
    document.body.dataset.mode = store.mode;
    document.querySelectorAll<HTMLElement>('.slot').forEach((s) => (s.hidden = s.dataset.mode !== store.mode));
    syncSelection();
  };

  // 3D picking: lasers in program mode, anything in stage mode.
  const vp = studio.viewport!;
  vp.onPick = (p, additive) => {
    if (store.mode === 'stage') {
      store.setSel({ element: p?.id ?? null });
      return;
    }
    if (!p || p.kind !== 'fixture') {
      if (!additive) store.setSel({ fixtures: [] });
      return;
    }
    const cur = store.sel.fixtures;
    store.setSel({ fixtures: additive ? (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]) : [p.id] });
  };
  vp.onMove = (p, pos) => {
    store.edit(
      (s) => {
        const el = s.stage.elements.find((e) => e.id === p.id);
        if (el) el.position = pos;
        const f = s.fixtures.find((x) => x.id === p.id);
        if (f) f.position = pos;
      },
      { coalesce: `gizmo-${p.id}`, source: 'gizmo' },
    );
  };
  vp.onMoveEnd = () => store.emit('show');

  function syncSelection() {
    vp.setWorkLights(store.mode === 'stage');
    if (store.mode === 'stage') {
      const id = store.sel.element;
      vp.setSelection(new Set(id ? [id] : []));
      const isFloor = store.show.stage.elements.find((e) => e.id === id)?.kind === 'floor';
      vp.setGizmo(id && !isFloor ? { kind: store.show.fixtures.some((f) => f.id === id) ? 'fixture' : 'element', id } : null);
    } else {
      vp.setSelection(new Set(store.sel.fixtures));
      vp.setGizmo(null);
    }
  }

  store.subscribe((c) => {
    if (c.topics.has('mode')) applyMode();
    else if (c.topics.has('sel') || c.topics.has('show')) queueMicrotask(syncSelection);
  });
  applyMode();

  // HUD: what's playing, fps, beam count.
  setInterval(() => {
    const cue = store.show.cues.find((c) => c.id === studio.frame.activeCueId);
    const prog = store.live.programmer ? ' · editing' : '';
    const pads = store.live.activePads.length ? ` · ${store.live.activePads.length} pad(s)` : '';
    hud.textContent = `${cue ? cue.name : 'No cue'}${prog}${pads} · ${vp.beamCount} beams · ${Math.round(studio.fps)} fps${store.live.blackout ? ' · BLACKOUT' : ''}`;
  }, 250);

  // The output window says hello when it opens; send it everything.
  onBroadcast((m) => (m as { type?: string })?.type === 'hello' && studio.broadcast(true));

  installShortcuts(store, studio);

  window.addEventListener('beforeunload', (e) => {
    if (store.dirty && !isDesktop) e.preventDefault();
  });

  // Launched by double-clicking a show file: open it and skip autosave recovery.
  const launched = await startupFile().catch(() => null);
  if (launched) {
    try {
      await studio.openFile(launched);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
    return;
  }

  // First run: show the tour. Later runs: offer to restore the autosave.
  if (!tourDone()) {
    startTour(studio);
    return;
  }
  const saved = Store.loadAutosave();
  if (saved && saved.show.cues.length) {
    const restore = await modal('Restore last session?', `Laser Studio found an autosave of “${saved.name}”.`, [
      { label: 'Start fresh', value: false },
      { label: 'Restore', value: true, primary: true },
    ]);
    if (restore) {
      store.replaceShow(saved.show, { path: saved.path, name: saved.name });
      store.dirty = true;
      store.emit('file');
      studio.viewport?.setCamera('foh');
    }
  }
}

function installShortcuts(store: Store, studio: Studio) {
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    return t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox';
  };
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod) {
      if (k === 's') {
        e.preventDefault();
        void studio.save(e.shiftKey);
      } else if (k === 'o') {
        e.preventDefault();
        void studio.open();
      } else if (k === 'z' && !typing(e)) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (k === 'y' && !typing(e)) {
        e.preventDefault();
        store.redo();
      }
      return;
    }
    if (typing(e) || document.querySelector('.modal-overlay')) return;
    const cam = CAMERA_PRESETS.find((c) => c.key === e.key);
    if (cam) {
      e.preventDefault();
      studio.setCamera(cam.id);
      return;
    }
    if (e.repeat) return;
    const pad = store.show.pads.find((p) => p.key && p.key === k);
    if (pad) {
      held.add(k);
      studio.padDown(pad.id);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        studio.togglePlay();
        return;
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) studio.back();
        else studio.go();
        return;
      case 'Escape':
        studio.clearProgrammer();
        return;
      case 'Delete':
      case 'Backspace':
        if (store.mode === 'stage' && store.sel.element) {
          const id = store.sel.element;
          if (store.show.stage.elements.find((x) => x.id === id)?.kind === 'floor') return;
          store.edit((s) => {
            s.stage.elements = s.stage.elements.filter((x) => x.id !== id);
            s.fixtures = s.fixtures.filter((x) => x.id !== id);
            for (const c of s.cues) delete c.looks[id];
          });
          store.setSel({ element: null });
          store.pruneSelection();
        }
        return;
    }
    switch (k) {
      case 'b':
        studio.toggleBlackout();
        break;
      case 't':
        studio.tap();
        break;
      case 'r':
        if (store.mode === 'program') studio.recordCue();
        break;
      case 'f':
        if (store.mode === 'show') studio.addHit('flash');
        break;
      case 's':
        if (store.mode === 'show') studio.addHit('strobe');
        break;
      case 'k':
        if (store.mode === 'show') studio.addHit('blackout');
        break;
      case 'a':
        if (store.mode === 'program') store.setSel({ fixtures: store.show.fixtures.map((f) => f.id) });
        break;
      case '?':
        void modal('Keyboard shortcuts', shortcutHelp(), [{ label: 'Close', value: true, primary: true }]);
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (!held.has(k)) return;
    held.delete(k);
    const pad = store.show.pads.find((p) => p.key === k);
    if (pad) studio.padUp(pad.id);
  });
  window.addEventListener('blur', () => {
    // Don't leave flash pads stuck on when the window loses focus.
    for (const k of held) {
      const pad = store.show.pads.find((p) => p.key === k);
      if (pad) studio.padUp(pad.id);
    }
    held.clear();
  });
  window.addEventListener('error', (e) => toast(`Error: ${e.message}`, 'error'));
}

function shortcutHelp() {
  const rows: [string, string][] = [
    ['Space', 'Play / pause music'],
    ['Enter / Shift+Enter', 'GO next cue / previous cue'],
    ['1 – 8 (hold)', 'Flash pads'],
    ['B', 'Blackout'],
    ['T', 'Tap tempo'],
    ['R', 'Record new cue (Program)'],
    ['A', 'Select all lasers (Program)'],
    ['Esc', 'Clear programmer'],
    ['F / S / K', 'Add flash / strobe / blackout hit (Show)'],
    ['Del', 'Delete selected (Stage, Timeline)'],
    ['F1 – F5', 'Camera presets'],
    ['Ctrl+S / Ctrl+Shift+S / Ctrl+O', 'Save / Save as / Open'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
  ];
  return h('table', { class: 'shortcuts' }, ...rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))));
}
