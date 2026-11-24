import './styles/app.css';
import { isDesktop, onBroadcast, startupFile } from './platform/bridge';
import { CAMERA_PRESETS } from './render/viewport';
import { h, modal, toast } from './ui/dom';
import { mountOutputView } from './ui/output-view';
import { Outputs } from './ui/outputs';
import { mountCueList, mountEffectEditor, mountFixtureList } from './ui/program';
import { mountSetup } from './ui/setup';
import { mountPlanView, mountStageInspector, mountStageList, mountStageTools, placeStageItem, STAGE_ITEM_MIME, type StageItemKind } from './ui/stage-editor';
import type { Vec3 } from './core/types';
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
  // Move / rotate / scale from the 3D gizmo or by dragging objects directly.
  let dragNo = 0;
  let startSize: Vec3 | null = null;
  vp.onTransformStart = (p) => {
    dragNo++;
    startSize = store.show.stage.elements.find((e) => e.id === p.id)?.size.slice() as Vec3 | undefined ?? null;
  };
  vp.onTransform = (p, t) => {
    store.edit(
      (s) => {
        const el = s.stage.elements.find((e) => e.id === p.id);
        const f = s.fixtures.find((x) => x.id === p.id);
        if (t.position) {
          if (el) el.position = t.position;
          if (f) f.position = t.position;
        }
        if (t.rotation) {
          if (el) el.rotation = t.rotation[0];
          if (f) f.aim = [t.rotation[0], Math.max(-90, Math.min(90, t.rotation[1]))];
        }
        if (t.scale && el && startSize) {
          el.size = startSize.map((v, i) => Math.max(0.05, Math.round(v * t.scale![i] * 100) / 100)) as Vec3;
        }
      },
      { coalesce: `gizmo-${p.id}-${dragNo}`, source: 'gizmo', gesture: true },
    );
  };
  vp.onMoveEnd = () => store.emit('show');
  mountStageTools(viewport, studio);
  // Drop items from the Stage add buttons straight into the 3D view.
  viewport.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(STAGE_ITEM_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  viewport.addEventListener('drop', (e) => {
    const kind = e.dataTransfer?.getData(STAGE_ITEM_MIME) as StageItemKind | undefined;
    if (!kind) return;
    e.preventDefault();
    const xz = vp.floorPointAt(e.clientX, e.clientY);
    if (xz) placeStageItem(studio, kind, [Math.round(xz[0] * 2) / 2, Math.round(xz[1] * 2) / 2]);
  });

  function syncSelection() {
    vp.setWorkLights(store.mode === 'stage');
    if (store.mode === 'stage') {
      const id = store.sel.element;
      vp.setSelection(new Set(id ? [id] : []));
      const isFloor = store.show.stage.elements.find((e) => e.id === id)?.kind === 'floor';
      const elKind = store.show.stage.elements.find((e) => e.id === id)?.kind;
      vp.setGizmo(id && !isFloor ? { kind: elKind ? 'element' : 'fixture', id } : null, elKind);
      vp.dragEnabled = true;
      vp.floorIds = new Set(store.show.stage.elements.filter((e) => e.kind === 'floor').map((e) => e.id));
    } else {
      vp.setSelection(new Set(store.sel.fixtures));
      vp.setGizmo(null);
      vp.dragEnabled = false;
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
  // Dev builds only: handy for debugging and automated UI tests.
  if (import.meta.env.DEV) (window as unknown as { __studio: Studio }).__studio = studio;
  installFileDrop(studio);
  // Reconnect the live audio input used last time (desktop: system audio or an input).
  void studio.audio.restoreLive();

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

const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'z', 'x']);

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
      } else if (k === 'd' && store.mode === 'stage' && !typing(e)) {
        e.preventDefault();
        studio.duplicateStageItem();
      } else if (k === 'a' && store.mode === 'program' && !typing(e)) {
        e.preventDefault();
        store.setSel({ fixtures: store.show.fixtures.map((f) => f.id) });
      } else if (k === 'y' && !typing(e)) {
        e.preventDefault();
        store.redo();
      }
      return;
    }
    if (typing(e) || document.querySelector('.modal-overlay')) return;
    // Camera: WASD move, Q/E turn, Z/X look up/down (Shift = faster). Works in every tab.
    if (FLY_KEYS.has(k) && !e.altKey) {
      e.preventDefault();
      studio.viewport?.flyKeys.add(k);
      if (e.shiftKey) studio.viewport?.flyKeys.add('shift');
      return;
    }
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
        if (store.mode === 'stage') studio.deleteStageItem();
        return;
    }
    if (store.mode === 'stage') {
      const tool = ({ g: 'translate', r: 'rotate', c: 'scale' } as const)[k as 'g' | 'r' | 'c'];
      if (tool) {
        studio.setStageTool(tool);
        return;
      }
      if (k === 'f' && store.sel.element) {
        studio.viewport?.focus(store.sel.element);
        return;
      }
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
      case 'g':
        if (store.mode === 'show') studio.addHit('strobe');
        break;
      case 'k':
        if (store.mode === 'show') studio.addHit('blackout');
        break;
      case '?':
        void modal('Keyboard shortcuts', shortcutHelp(), [{ label: 'Close', value: true, primary: true }]);
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (FLY_KEYS.has(k)) studio.viewport?.flyKeys.delete(k);
    if (e.key === 'Shift') studio.viewport?.flyKeys.delete('shift');
    if (!held.has(k)) return;
    held.delete(k);
    const pad = store.show.pads.find((p) => p.key === k);
    if (pad) studio.padUp(pad.id);
  });
  window.addEventListener('blur', () => {
    studio.viewport?.flyKeys.clear();
    // Don't leave flash pads stuck on when the window loses focus.
    for (const k of held) {
      const pad = store.show.pads.find((p) => p.key === k);
      if (pad) studio.padUp(pad.id);
    }
    held.clear();
  });
  window.addEventListener('error', (e) => toast(`Error: ${e.message}`, 'error'));
}

/** Drop songs, shows or ILDA files anywhere on the window. */
function installFileDrop(studio: Studio) {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', { class: 'drop-card' }, h('div', { class: 'drop-icon' }, '♫'), h('h2', null, 'Drop a song to build a light show'), h('p', null, 'or a .lshow show · an .ild laser graphic')));
  document.body.appendChild(overlay);
  // Internal drags (cues onto the timeline) carry no files — ignore those.
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (file) void studio.dropFile(file);
  });
}

function shortcutHelp() {
  const rows: [string, string][] = [
    ['Space', 'Play / pause music'],
    ['Enter / Shift+Enter', 'GO next cue / previous cue'],
    ['1 – 8 (hold)', 'Flash pads'],
    ['B', 'Blackout'],
    ['T', 'Tap tempo'],
    ['W A S D', 'Move the camera (Shift = faster)'],
    ['Q / E', 'Turn the camera left / right'],
    ['Z / X', 'Look up / down'],
    ['R', 'Record new cue (Program)'],
    ['Ctrl+A', 'Select all lasers (Program)'],
    ['Esc', 'Clear programmer'],
    ['F / G / K', 'Add flash / strobe / blackout hit (Show)'],
    ['Del', 'Delete selected (Stage, Timeline)'],
    ['G / R / C', 'Move / Rotate / Scale tool (Stage)'],
    ['F', 'Focus camera on selection (Stage)'],
    ['Ctrl+D', 'Duplicate selection (Stage)'],
    ['Drag object · Shift-drag', 'Slide along the floor · lift up/down (Stage, Move tool)'],
    ['F1 – F5', 'Camera presets'],
    ['Ctrl+S / Ctrl+Shift+S / Ctrl+O', 'Save / Save as / Open'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
  ];
  return h('table', { class: 'shortcuts' }, ...rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d))));
}
