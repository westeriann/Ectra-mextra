// The controller: owns the store, the audio player, the 3D viewport and the
// beat clock, and exposes the actions every panel, shortcut, OSC message and
// MIDI control calls.

import { autoProgram } from '../core/analysis';
import { BeatClock, evaluate, goCue, nextCue, prevCue, songBeat, type Clock, type Frame } from '../core/engine';
import { builtinShapes, parseIlda } from '../core/ilda';
import { effect, FILE_EXTENSION, makeCue, newShow, parseShow, serializeShow } from '../core/show';
import type { Cue, Effect, FixtureLook, HitKind, Show, Vec3 } from '../core/types';
import { deepClone, uid } from '../core/util';
import * as bridge from '../platform/bridge';
import { Viewport, type CameraPreset, type GizmoMode } from '../render/viewport';
import { AudioPlayer } from './audio';
import { generateShow, VIBES, type GenerateOptions, type Vibe } from '../core/generate';
import { h, modal, select, toast } from './dom';
import { Store } from './store';

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'];

export interface SyncMessage {
  type: 'state';
  show?: Show;
  live: Store['live'];
  songTime: number | null;
  playing: boolean;
  /** Editor's wall clock and effect time, so fades and phases match exactly. */
  wall: number;
  time: number;
  beat: number;
  bpm: number;
  level: number;
  at: number;
}

export class Studio {
  readonly audio = new AudioPlayer();
  readonly beatClock: BeatClock;
  viewport: Viewport | null = null;
  frame: Frame;
  /** When armed, GO/cue presses during playback are written into the timeline. */
  recordArm = false;
  private last = performance.now();
  private wall0 = performance.now();
  private raf = 0;
  private lastBroadcast = 0;
  /** True when the output window needs the full show again. */
  private showDirty = true;
  fps = 0;
  /** Hooks run every frame after evaluation (hardware outputs). */
  readonly frameHooks: ((frame: Frame, show: Show) => void)[] = [];

  constructor(readonly store: Store) {
    this.beatClock = new BeatClock(store.show.bpm);
    this.frame = evaluate(store.show, store.live, this.clock());
    this.audio.onEnded = () => this.store.emit('transport');
    this.ensureBuiltinShapes();
    store.subscribe((c) => {
      if (c.topics.has('show')) {
        this.showDirty = true;
        if (!this.audio.loaded) this.beatClock.bpm = store.show.bpm;
      }
    });
  }

  // ---------------------------------------------------------------- clock

  get wall() {
    return (performance.now() - this.wall0) / 1000;
  }

  /** Song position when a track is loaded, else null. */
  get songTime(): number | null {
    return this.audio.loaded ? this.audio.time : null;
  }

  get bpm(): number {
    return this.store.show.music && this.audio.loaded ? this.store.show.music.bpm : this.beatClock.bpm;
  }

  clock(): Clock {
    const song = this.songTime;
    const music = this.store.show.music;
    if (song !== null && music && this.audio.playing) {
      return { wall: this.wall, time: song, beat: songBeat(song, music.bpm, music.offset), songTime: song, level: this.audio.level(), songClock: true };
    }
    // Not playing: effects keep running on the free clock so the rig never freezes,
    // but a paused song still decides which timeline cue is shown.
    return { wall: this.wall, time: this.wall, beat: this.beatClock.beat, songTime: song, level: this.audio.level() };
  }

  // ---------------------------------------------------------------- loop

  start(container: HTMLElement) {
    this.viewport = new Viewport(container, { interactive: true });
    this.viewport.syncShow(this.store.show, true);
    this.viewport.setCamera('foh');
    this.viewport.onRecorded = (blob, ext) => {
      void bridge.saveBinaryFile(blob, { suggested: `${this.store.show.name}.${ext}`, label: 'Video', ext }).then((p) => p && toast(`Saved video ${p}`));
    };
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.beatClock.advance(dt);
    const show = this.store.show;
    const clock = this.clock();
    this.frame = evaluate(show, this.store.live, clock);
    if (this.viewport) {
      this.viewport.syncShow(show);
      this.viewport.render(show, this.frame, clock.time, dt);
    }
    for (const hook of this.frameHooks) hook(this.frame, show);
    if (now - this.lastBroadcast > 50) {
      this.lastBroadcast = now;
      this.broadcast();
    }
  }

  /** Keep the output window(s) in sync. The show is only re-sent when it changed. */
  broadcast(force = false) {
    const show = this.store.show;
    const clock = this.clock();
    const msg: SyncMessage = {
      type: 'state',
      live: this.store.live,
      songTime: this.songTime,
      playing: this.audio.playing,
      wall: clock.wall,
      time: clock.time,
      beat: clock.beat,
      bpm: this.bpm,
      level: this.frame.level,
      at: Date.now(),
    };
    if (force || this.showDirty) {
      msg.show = show;
      this.showDirty = false;
    }
    bridge.broadcast(msg);
  }

  // ---------------------------------------------------------------- transport

  play() {
    if (!this.audio.loaded) {
      toast('Load a song first (Show tab → Load music) — or use the cue list to run the show live.');
      return;
    }
    this.audio.play();
    this.store.emit('transport');
  }

  pause() {
    this.audio.pause();
    this.store.emit('transport');
  }

  togglePlay() {
    if (this.audio.playing) this.pause();
    else this.play();
  }

  stopTransport() {
    this.audio.stop();
    this.store.emit('transport');
  }

  seek(t: number) {
    this.audio.seek(t);
    this.store.emit('transport');
  }

  tap() {
    const bpm = this.beatClock.tap(this.wall);
    if (bpm && !this.audio.loaded) {
      this.store.edit((s) => (s.bpm = bpm), { coalesce: 'tap' });
    }
  }

  // ---------------------------------------------------------------- cues

  goCue(cue: Cue | null) {
    const { store } = this;
    // While music plays with timeline control, a manual GO takes over (and is recorded when armed).
    if (this.recordArm && this.audio.playing && cue) {
      const t = this.audio.time;
      store.edit((s) => {
        s.timeline.cues = s.timeline.cues.filter((e) => Math.abs(e.time - t) > 0.05);
        s.timeline.cues.push({ id: uid('tc'), time: t, cueId: cue.id });
        s.timeline.cues.sort((a, b) => a.time - b.time);
      });
      return;
    }
    store.setLive({ ...goCue(store.live, cue, this.wall), timelineControl: false });
  }

  go() {
    this.goCue(nextCue(this.store.show, this.store.live));
  }

  back() {
    this.goCue(prevCue(this.store.show, this.store.live));
  }

  goCueById(id: string) {
    const cue = this.store.show.cues.find((c) => c.id === id) ?? null;
    this.goCue(cue);
  }

  goCueByNumber(n: number) {
    const cue = this.store.show.cues[n - 1];
    if (cue) this.goCue(cue);
  }

  release() {
    this.store.setLive({ cueId: null, prevCueId: this.store.live.cueId, fadeStart: this.wall, fadeDuration: 0.5, timelineControl: false });
  }

  /** Give cue control back to the timeline. */
  followTimeline() {
    this.store.setLive({ timelineControl: true });
  }

  padDown(padId: string) {
    const pad = this.store.show.pads.find((p) => p.id === padId);
    if (!pad) return;
    const active = new Set(this.store.live.activePads);
    if (pad.mode === 'toggle' && active.has(padId)) active.delete(padId);
    else active.add(padId);
    this.store.setLive({ activePads: [...active] });
  }

  padUp(padId: string) {
    const pad = this.store.show.pads.find((p) => p.id === padId);
    if (!pad || pad.mode === 'toggle') return;
    this.store.setLive({ activePads: this.store.live.activePads.filter((p) => p !== padId) });
  }

  setMaster(v: number) {
    this.store.setLive({ master: Math.max(0, Math.min(1, v)) });
  }

  toggleBlackout() {
    this.store.setLive({ blackout: !this.store.live.blackout });
  }

  addHit(kind: HitKind) {
    const t = this.songTime;
    if (t === null) return;
    this.store.edit((s) => s.timeline.hits.push({ id: uid('hit'), time: t, duration: kind === 'flash' ? 0.4 : 1, kind }));
  }

  // ---------------------------------------------------------------- programmer

  /** The look a fixture currently shows (programmer → running cue → default). */
  currentLook(fixtureId: string): FixtureLook {
    const live = this.store.live;
    if (live.programmer?.[fixtureId]) return live.programmer[fixtureId];
    const cue = this.store.show.cues.find((c) => c.id === (this.frame.activeCueId ?? live.cueId));
    return cue?.looks[fixtureId] ?? { on: true, effect: effect() };
  }

  /** Apply effect changes to the selected fixtures, via the programmer. */
  program(patch: Partial<Effect> & { on?: boolean }, fixtureIds = this.store.sel.fixtures) {
    if (!fixtureIds.length) {
      toast('Select one or more lasers first.');
      return;
    }
    const prog = { ...(this.store.live.programmer ?? {}) };
    const { on, ...fx } = patch;
    for (const id of fixtureIds) {
      const base = deepClone(prog[id] ?? this.currentLook(id));
      prog[id] = { on: on ?? base.on, effect: { ...base.effect, ...fx } };
    }
    this.store.setLive({ programmer: prog }, 'programmer');
  }

  clearProgrammer() {
    this.store.setLive({ programmer: null });
  }

  /** Load a cue into the programmer for editing. */
  editCue(id: string) {
    const cue = this.store.show.cues.find((c) => c.id === id);
    if (!cue) return;
    this.store.setSel({ cueId: id, fixtures: this.store.sel.fixtures.length ? this.store.sel.fixtures : this.store.show.fixtures.map((f) => f.id) });
    this.store.setLive({ ...goCue(this.store.live, cue, this.wall), fadeDuration: 0, programmer: deepClone(cue.looks), timelineControl: false });
  }

  /** Write the programmer into the cue being edited. */
  updateCue() {
    const id = this.store.sel.cueId;
    const prog = this.store.live.programmer;
    if (!id || !prog) {
      toast('Pick a cue to update (Edit on a cue), then change the look.');
      return;
    }
    this.store.edit((s) => {
      const cue = s.cues.find((c) => c.id === id);
      if (cue) {
        cue.looks = { ...cue.looks, ...deepClone(prog) };
        delete cue.auto; // edited by hand: keep it when the song show is regenerated
      }
    });
    this.store.setLive({ programmer: null, cueId: id, prevCueId: null });
    toast('Cue updated');
  }

  /** Record what's on stage (running cue + programmer) as a new cue. */
  recordCue() {
    const live = this.store.live;
    const running = this.store.show.cues.find((c) => c.id === (this.frame.activeCueId ?? live.cueId));
    const looks = { ...deepClone(running?.looks ?? {}), ...deepClone(live.programmer ?? {}) };
    if (!Object.keys(looks).length) {
      toast('Nothing to record — select lasers and pick an effect first.');
      return;
    }
    const cue = makeCue(`Cue ${this.store.show.cues.length + 1}`, looks, { tag: running?.tag ?? '#4cc9f0' });
    this.store.edit((s) => s.cues.push(cue));
    this.store.setSel({ cueId: cue.id });
    this.store.setLive({ programmer: null, cueId: cue.id, prevCueId: null, timelineControl: false });
    toast(`Recorded ${cue.name}`);
  }

  // ---------------------------------------------------------------- files

  async confirmDiscard(): Promise<boolean> {
    if (!this.store.dirty) return true;
    const r = await modal('Unsaved changes', 'Your show has unsaved changes. Save first?', [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't save", value: 'discard' },
      { label: 'Save', value: 'save', primary: true },
    ]);
    if (r === 'save') return this.save();
    return r === 'discard';
  }

  async newShow(templateId: string) {
    if (!(await this.confirmDiscard())) return;
    this.audio.unload();
    const show = newShow(templateId);
    this.ensureBuiltinShapes(show);
    this.store.replaceShow(show);
    this.beatClock.bpm = show.bpm;
    this.viewport?.setCamera('foh');
  }

  async open() {
    if (!(await this.confirmDiscard())) return;
    try {
      const f = await bridge.openTextFile('Laser Studio Show', [FILE_EXTENSION, 'json']);
      if (!f) return;
      const show = parseShow(f.text);
      this.ensureBuiltinShapes(show);
      this.audio.unload();
      this.store.replaceShow(show, { path: f.path, name: f.name });
      this.viewport?.setCamera('foh');
      if (show.music?.path && bridge.isDesktop) await this.loadMusicFromPath(show.music.path).catch(() => toast(`Couldn't find the music file ${show.music?.path} — use Load music to relink it.`, 'error'));
      else if (show.music) toast(`This show uses "${show.music.name}". Use Load music to attach it.`);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
  }

  /** Open a show already read from disk (startup file). */
  async openFile(f: { name: string; path?: string; text: string }) {
    const show = parseShow(f.text);
    this.ensureBuiltinShapes(show);
    this.audio.unload();
    this.store.replaceShow(show, { path: f.path, name: f.name });
    this.viewport?.setCamera('foh');
    if (show.music?.path && bridge.isDesktop) await this.loadMusicFromPath(show.music.path).catch(() => toast(`Couldn't find the music file ${show.music?.path}`, 'error'));
  }

  async save(saveAs = false): Promise<boolean> {
    try {
      const name = this.store.fileName.endsWith(`.${FILE_EXTENSION}`) ? this.store.fileName : `${this.store.show.name}.${FILE_EXTENSION}`;
      const path = await bridge.saveTextFile(serializeShow(this.store.show), { path: this.store.filePath, suggested: name, label: 'Laser Studio Show', ext: FILE_EXTENSION, saveAs });
      if (!path) return false;
      this.store.markSaved(bridge.isDesktop ? path : undefined, path.split(/[\\/]/).pop() ?? name);
      toast('Saved');
      return true;
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      return false;
    }
  }

  async loadMusic() {
    const f = await bridge.openBinaryFile('Audio', AUDIO_EXTENSIONS);
    if (!f) return;
    if (await this.attachMusic(f.data, f.name, f.path)) await this.offerSongShow(f.name);
  }

  /** Handle a file dropped onto the window: a song, a show, or an ILDA graphic. */
  async dropFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    try {
      if (AUDIO_EXTENSIONS.includes(ext) || file.type.startsWith('audio/')) {
        await this.dropMusic(await file.arrayBuffer(), file.name);
      } else if (ext === FILE_EXTENSION || ext === 'json') {
        if (await this.confirmDiscard()) await this.openFile({ name: file.name, text: await file.text() });
      } else if (ext === 'ild' || ext === 'ilda') {
        const shape = parseIlda(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
        this.store.edit((s) => s.shapes.push(shape));
        toast(`Imported ${shape.name} — use it with the Shape effect`);
      } else {
        toast(`Laser Studio can't open .${ext} files. Drop a song (mp3, wav, ogg, flac, m4a), a .lshow show or an .ild graphic.`, 'error');
      }
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
  }

  /** A song dropped onto the window: load it and offer to build a show from it. */
  async dropMusic(data: ArrayBuffer, name: string) {
    this.store.setMode('show');
    if (await this.attachMusic(data, name, undefined)) await this.offerSongShow(name);
  }

  /** Song → show settings (kept between generations so Remix can step through variations). */
  songShow = { vibe: 'auto' as Vibe, variation: 0, barsPerVariation: 8 };

  private async offerSongShow(name: string) {
    const opts = { ...this.songShow, variation: 0 };
    const go = await modal(
      'Create a light show from this song?',
      h(
        'div',
        { class: 'form' },
        h('p', null, `Laser Studio will map “${name}” into sections (intro, builds, drops…) and design brand-new cues, colours, hits and build-ups just for it. You can remix it, edit anything, or undo.`),
        select({ label: 'Vibe', value: opts.vibe, options: VIBES, onChange: (v) => (opts.vibe = v) }),
        select({
          label: 'New look every',
          value: String(opts.barsPerVariation),
          options: [{ value: '4', label: '4 bars' }, { value: '8', label: '8 bars' }, { value: '16', label: '16 bars' }],
          onChange: (v) => (opts.barsPerVariation = Number(v)),
        }),
      ),
      [
        { label: 'Just load the song', value: false },
        { label: 'Create show', value: true, primary: true },
      ],
    );
    if (go) this.generateSongShow(opts);
  }

  /** Design a fresh show for the loaded song. Replaces earlier generated cues you haven't edited. */
  generateSongShow(opts: Partial<GenerateOptions> = {}) {
    const a = this.audio.analysis;
    const music = this.store.show.music;
    if (!a || !music) {
      toast('Load or drop a song first.');
      return;
    }
    this.songShow = { ...this.songShow, ...opts };
    const g = generateShow(this.store.show, a, music, this.songShow);
    this.store.edit((s) => {
      const padCues = new Set(s.pads.map((p) => p.cueId));
      s.cues = s.cues.filter((c) => !c.auto || padCues.has(c.id));
      s.cues.push(...g.cues);
      s.timeline = g.timeline;
    });
    this.store.setLive({ timelineControl: true, cueId: null, prevCueId: null, programmer: null });
    this.seek(0);
    const drops = g.sections.filter((s) => s.kind === 'drop').length;
    toast(`Created ${g.cues.length} cues across ${g.sections.length} sections (${drops} drop${drops === 1 ? '' : 's'}). Press Space to play · Ctrl+Z to undo`);
  }

  remixSongShow() {
    this.generateSongShow({ variation: this.songShow.variation + 1 });
  }

  private async loadMusicFromPath(path: string) {
    const data = await bridge.readBinary(path);
    await this.attachMusic(data, path.split(/[\\/]/).pop() ?? path, path, true);
  }

  private async attachMusic(data: ArrayBuffer, name: string, path: string | undefined, keepGrid = false): Promise<boolean> {
    toast(`Analysing ${name}…`);
    try {
      const a = await this.audio.load(data);
      const prev = this.store.show.music;
      this.store.edit((s) => {
        s.music = {
          name,
          path,
          duration: a.duration,
          // Re-opening a show keeps the tempo the user may have corrected by hand.
          bpm: keepGrid && prev ? prev.bpm : a.bpm,
          offset: keepGrid && prev ? prev.offset : a.offset,
          beatsPerBar: prev?.beatsPerBar ?? 4,
        };
      });
      this.store.setLive({ timelineControl: true });
      this.store.emit('transport');
      toast(`${name}: ${a.bpm} BPM detected`);
      return true;
    } catch (e) {
      toast(`Couldn't decode ${name}: ${e instanceof Error ? e.message : e}`, 'error');
      return false;
    }
  }

  autoProgram(barsPerCue: number, accents: boolean) {
    const a = this.audio.analysis;
    if (!a) {
      toast('Load music first.');
      return;
    }
    const music = this.store.show.music!;
    const res = autoProgram(this.store.show, { ...a, bpm: music.bpm, offset: music.offset }, { barsPerCue, accents });
    this.store.edit((s) => {
      s.cues.push(...res.added);
      s.timeline.cues = res.cues;
      s.timeline.hits = res.hits;
    });
    this.store.setLive({ timelineControl: true });
    toast(`Placed ${res.cues.length} cues and ${res.hits.length} hits`);
  }

  async importIlda() {
    const f = await bridge.openBinaryFile('ILDA laser graphics', ['ild', 'ilda']);
    if (!f) return;
    try {
      const shape = parseIlda(f.data, f.name.replace(/\.[^.]+$/, ''));
      this.store.edit((s) => s.shapes.push(shape));
      toast(`Imported ${shape.name} (${shape.frames.length} frame${shape.frames.length > 1 ? 's' : ''}) — use it with the Shape effect`);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    }
  }

  private ensureBuiltinShapes(show = this.store.show) {
    for (const s of builtinShapes()) if (!show.shapes.some((x) => x.id === s.id)) show.shapes.push(s);
  }

  // ---------------------------------------------------------------- stage editing

  stageTool: GizmoMode = 'translate';

  setStageTool(tool: GizmoMode) {
    this.stageTool = tool;
    this.viewport?.setGizmoMode(tool);
    this.store.emit('sel');
  }

  setStageSnap(on: boolean) {
    this.viewport?.setGizmoSnap(on);
    this.store.emit('sel');
  }

  /** Duplicate the selected stage element or laser (lasers copy their looks in every cue). */
  duplicateStageItem() {
    const id = this.store.sel.element;
    const el = this.store.show.stage.elements.find((e) => e.id === id);
    const f = this.store.show.fixtures.find((x) => x.id === id);
    if (el && el.kind !== 'floor') {
      const copy = { ...deepClone(el), id: uid('el'), name: `${el.name} copy`, position: [el.position[0] + 1, el.position[1], el.position[2] + 1] as Vec3 };
      this.store.edit((s) => s.stage.elements.push(copy));
      this.store.setSel({ element: copy.id });
    } else if (f) {
      const copy = { ...deepClone(f), id: uid('fx'), name: `${f.name} copy`, position: [f.position[0] + 1, f.position[1], f.position[2]] as Vec3 };
      copy.dmx = { ...f.dmx, address: Math.min(503, Math.max(0, ...this.store.show.fixtures.map((x) => x.dmx.address + 9)) + 1) };
      this.store.edit((s) => {
        s.fixtures.push(copy);
        for (const c of s.cues) if (c.looks[f.id]) c.looks[copy.id] = deepClone(c.looks[f.id]);
      });
      this.store.setSel({ element: copy.id });
    }
  }

  deleteStageItem() {
    const id = this.store.sel.element;
    if (!id || this.store.show.stage.elements.find((x) => x.id === id)?.kind === 'floor') return;
    this.store.edit((s) => {
      s.stage.elements = s.stage.elements.filter((x) => x.id !== id);
      s.fixtures = s.fixtures.filter((x) => x.id !== id);
      for (const c of s.cues) delete c.looks[id];
    });
    this.store.setSel({ element: null });
    this.store.pruneSelection();
  }

  // ---------------------------------------------------------------- view

  setCamera(p: CameraPreset) {
    this.viewport?.setCamera(p);
  }

  toggleRecording() {
    const vp = this.viewport;
    if (!vp) return;
    if (vp.recording) vp.stopRecording();
    else if (!vp.startRecording(this.audio.recordStream)) toast('Video recording is not supported here.', 'error');
    this.store.emit('transport');
  }
}
