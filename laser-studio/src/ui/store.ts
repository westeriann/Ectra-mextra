// App state with change notifications and undo/redo. Panels subscribe to the
// topics they care about; edits made by a panel carry its name as `source`
// so that panel can skip re-rendering itself (keeps focus while typing).

import { initialLive, type LiveState } from '../core/engine';
import { newShow, parseShow, serializeShow } from '../core/show';
import type { Show } from '../core/types';

export type Mode = 'program' | 'stage' | 'show' | 'setup';
export type Topic = 'show' | 'live' | 'mode' | 'sel' | 'file' | 'transport';

export interface Selection {
  fixtures: string[];
  /** Stage element selected in the stage designer. */
  element: string | null;
  /** Cue being edited / highlighted in the cue list. */
  cueId: string | null;
  timeline: { kind: 'cue' | 'hit'; id: string } | null;
}

export interface Change {
  topics: Set<Topic>;
  source?: string;
}

const AUTOSAVE_KEY = 'laser-studio:autosave';
const HISTORY_LIMIT = 150;

export class Store {
  show: Show;
  live: LiveState = initialLive();
  mode: Mode = 'program';
  sel: Selection = { fixtures: [], element: null, cueId: null, timeline: null };
  filePath: string | undefined;
  fileName = 'Untitled.lshow';
  dirty = false;
  /** Increments whenever a different show is loaded (new/open). */
  generation = 0;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCoalesce = { key: '', at: 0 };
  private listeners = new Set<(c: Change) => void>();
  private pending: Change | null = null;

  constructor(show?: Show) {
    this.show = show ?? newShow();
  }

  subscribe(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Batch notifications into one per microtask. */
  emit(topic: Topic, source?: string) {
    if (!this.pending) {
      this.pending = { topics: new Set(), source };
      queueMicrotask(() => {
        const c = this.pending!;
        this.pending = null;
        this.listeners.forEach((l) => l(c));
      });
    } else if (this.pending.source !== source) {
      // Mixed sources: everyone re-renders.
      this.pending.source = undefined;
    }
    this.pending.topics.add(topic);
  }

  /**
   * Change the show. `coalesce` merges rapid edits with the same key (e.g.
   * dragging a slider) into one undo step.
   */
  edit(fn: (show: Show) => void, opts: { source?: string; coalesce?: string } = {}) {
    const now = performance.now();
    const merge = opts.coalesce && opts.coalesce === this.lastCoalesce.key && now - this.lastCoalesce.at < 1000;
    if (!merge) {
      this.undoStack.push(serializeShow(this.show));
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastCoalesce = { key: opts.coalesce ?? '', at: now };
    fn(this.show);
    this.dirty = true;
    this.emit('show', opts.source);
    this.emit('file');
    this.scheduleAutosave();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(serializeShow(this.show));
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(serializeShow(this.show));
    this.restore(next);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  private restore(text: string) {
    this.show = parseShow(text);
    this.lastCoalesce = { key: '', at: 0 };
    this.pruneSelection();
    this.dirty = true;
    this.emit('show');
    this.emit('sel');
    this.emit('file');
  }

  /** Load a whole new show (new/open). Clears history. */
  replaceShow(show: Show, file?: { path?: string; name: string }) {
    this.show = show;
    this.generation++;
    this.undoStack = [];
    this.redoStack = [];
    this.live = { ...initialLive(), master: this.live.master };
    this.filePath = file?.path;
    this.fileName = file?.name ?? 'Untitled.lshow';
    this.dirty = false;
    this.sel = { fixtures: [], element: null, cueId: null, timeline: null };
    (['show', 'live', 'sel', 'file'] as Topic[]).forEach((t) => this.emit(t));
  }

  setLive(patch: Partial<LiveState>, source?: string) {
    this.live = { ...this.live, ...patch };
    this.emit('live', source);
  }

  setSel(patch: Partial<Selection>, source?: string) {
    this.sel = { ...this.sel, ...patch };
    this.emit('sel', source);
  }

  setMode(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('mode');
  }

  markSaved(path: string | undefined, name: string) {
    this.filePath = path;
    this.fileName = name;
    this.dirty = false;
    this.emit('file');
  }

  /** Drop selected ids that no longer exist (after undo/delete). */
  pruneSelection() {
    const fx = new Set(this.show.fixtures.map((f) => f.id));
    const el = new Set(this.show.stage.elements.map((e) => e.id));
    const cues = new Set(this.show.cues.map((c) => c.id));
    this.sel = {
      fixtures: this.sel.fixtures.filter((id) => fx.has(id)),
      element: this.sel.element && (el.has(this.sel.element) || fx.has(this.sel.element)) ? this.sel.element : null,
      cueId: this.sel.cueId && cues.has(this.sel.cueId) ? this.sel.cueId : null,
      timeline: this.sel.timeline,
    };
    if (this.live.programmer) {
      const prog = Object.fromEntries(Object.entries(this.live.programmer).filter(([id]) => fx.has(id)));
      this.live = { ...this.live, programmer: Object.keys(prog).length ? prog : null };
    }
  }

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleAutosave() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ show: this.show, path: this.filePath, name: this.fileName, at: Date.now() }));
      } catch {
        /* storage full or unavailable — autosave is best-effort */
      }
    }, 800);
  }

  static loadAutosave(): { show: Show; path?: string; name: string } | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return { show: parseShow(JSON.stringify(data.show)), path: data.path, name: data.name ?? 'Recovered.lshow' };
    } catch {
      return null;
    }
  }
}
