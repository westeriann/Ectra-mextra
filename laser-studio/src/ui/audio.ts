// Music playback and live audio. A song (sync mode), a microphone / line in,
// or — in the desktop app — system audio all feed one LiveAnalyzer, which
// gives the show auto-levelled bands, kick/snare/hat hits and a live tempo.

import { analyze, mixdown, type Analysis } from '../core/analysis';
import { LiveAnalyzer, SILENT, type AudioFeatures } from '../core/live';
import { isDesktop, nativeAudio, type AudioDeviceInfo } from '../platform/bridge';

/** Where live sound comes from when no song is playing. */
export interface LiveSource {
  id: string;
  name: string;
  kind: 'input' | 'system' | 'browser-mic';
}

const PREFS_KEY = 'laser-studio:live-audio';

/** Mixes everything it hears to mono and posts 1024-sample blocks. */
const TAP_WORKLET = `
class LsTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const a = ch[0], b = ch[1] || ch[0];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = (a[i] + b[i]) * 0.5;
        if (this.n === 1024) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('ls-tap', LsTap);
`;

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private tap: AudioNode | null = null;
  private tapReady: Promise<void> | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  playing = false;
  analysis: Analysis | null = null;
  onEnded: (() => void) | null = null;

  /** Analyses whatever is heard (song while it plays, otherwise the live source). */
  analyzer = new LiveAnalyzer(48000);
  /** The live input, or null when off. */
  live: LiveSource | null = null;
  /** Called when the live source changes or fails. */
  onLiveChange: ((error?: string) => void) | null = null;
  private liveGeneration = 0;
  private sensitivity = 1;

  constructor() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
      if (typeof p.sensitivity === 'number') this.sensitivity = p.sensitivity;
    } catch {
      /* no prefs */
    }
    this.analyzer.gain = this.sensitivity;
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.gain.connect(this.ctx.destination);
      this.gain.connect(this.recordDest);
      this.tapReady = this.setupTap(this.ctx);
    }
    return this.ctx;
  }

  /** A worklet (or ScriptProcessor fallback) that hands PCM blocks to the analyser. */
  private async setupTap(ctx: AudioContext) {
    const onBlock = (block: Float32Array) => {
      // This tap hears the song and the browser mic. Native inputs (incl. system
      // audio) arrive separately — don't let the tap's silence mix into them.
      if (!this.playing && this.live?.kind !== 'browser-mic') return;
      this.feed(block, ctx.sampleRate);
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node: AudioNode;
    try {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const w = new AudioWorkletNode(ctx, 'ls-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      w.port.onmessage = (e) => onBlock(e.data as Float32Array);
      node = w;
    } catch {
      const sp = ctx.createScriptProcessor(1024, 2, 1);
      sp.onaudioprocess = (e) => {
        const a = e.inputBuffer.getChannelData(0);
        const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
        const m = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) * 0.5;
        onBlock(m);
      };
      node = sp;
    }
    node.connect(sink);
    this.gain!.connect(node);
    this.tap = node;
  }

  private feed(block: Float32Array, sampleRate: number) {
    if (this.analyzer.fs !== sampleRate) {
      const g = this.analyzer.gain;
      this.analyzer = new LiveAnalyzer(sampleRate);
      this.analyzer.gain = g;
    }
    this.analyzer.feed(block, performance.now() / 1000);
  }

  // ------------------------------------------------------------ song playback

  get loaded() {
    return !!this.buffer;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  async load(data: ArrayBuffer): Promise<Analysis> {
    const ctx = this.ensure();
    this.stop();
    this.buffer = await ctx.decodeAudioData(data.slice(0));
    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, i) => this.buffer!.getChannelData(i));
    const mono = downsample(mixdown(channels), 2);
    this.analysis = analyze(mono, this.buffer.sampleRate / 2);
    this.pausedAt = 0;
    return this.analysis;
  }

  unload() {
    this.stop();
    this.buffer = null;
    this.analysis = null;
  }

  get time(): number {
    if (!this.buffer) return 0;
    if (!this.playing || !this.ctx) return this.pausedAt;
    return Math.min(this.buffer.duration, this.ctx.currentTime - this.startedAt);
  }

  play() {
    if (!this.buffer || this.playing) return;
    const ctx = this.ensure();
    void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain!);
    const from = this.pausedAt >= this.buffer.duration ? 0 : this.pausedAt;
    src.start(0, from);
    this.startedAt = ctx.currentTime - from;
    src.onended = () => {
      if (this.source !== src) return;
      this.playing = false;
      this.pausedAt = this.buffer?.duration ?? 0;
      this.source = null;
      this.onEnded?.();
    };
    this.source = src;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.halt();
  }

  stop() {
    this.halt();
    this.pausedAt = 0;
  }

  private halt() {
    const s = this.source;
    this.source = null;
    this.playing = false;
    try {
      s?.stop();
    } catch {
      /* already stopped */
    }
  }

  seek(t: number) {
    const was = this.playing;
    this.halt();
    this.pausedAt = Math.max(0, Math.min(t, this.duration));
    if (was) this.play();
  }

  setVolume(v: number) {
    this.ensure();
    this.gain!.gain.value = v;
  }

  // ------------------------------------------------------------ live input

  /** Inputs the user can pick from. Desktop: native inputs + system audio. Browser: the microphone. */
  async liveSources(): Promise<LiveSource[]> {
    if (isDesktop) {
      const devs: AudioDeviceInfo[] = await nativeAudio.devices().catch(() => []);
      return devs
        .sort((a, b) => (a.kind === b.kind ? Number(b.isDefault) - Number(a.isDefault) : a.kind === 'system' ? -1 : 1))
        .map((d) => ({ id: d.id, name: d.kind === 'system' ? `System audio — ${d.name}` : d.name, kind: d.kind }));
    }
    return [{ id: 'browser-mic', name: 'Microphone / line in', kind: 'browser-mic' }];
  }

  async startLive(src: LiveSource): Promise<void> {
    await this.stopLive(false);
    const gen = ++this.liveGeneration;
    this.analyzer.reset(performance.now() / 1000);
    if (src.kind === 'browser-mic') {
      const ctx = this.ensure();
      await this.tapReady;
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.micSource = ctx.createMediaStreamSource(this.micStream);
      // Mic goes to the analyser only — never to the speakers (feedback).
      this.micSource.connect(this.tap!);
      await ctx.resume();
    } else {
      await nativeAudio.start(src.id, (block) => {
        if (gen !== this.liveGeneration || this.playing) return;
        this.feed(block, this.nativeRate);
      }).then((r) => (this.nativeRate = r.sampleRate));
    }
    this.live = src;
    this.savePrefs();
    this.onLiveChange?.();
  }
  private nativeRate = 48000;

  async stopLive(notify = true) {
    this.liveGeneration++;
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micStream = null;
    if (this.live && this.live.kind !== 'browser-mic') await nativeAudio.stop().catch(() => {});
    this.live = null;
    this.savePrefs();
    if (notify) this.onLiveChange?.();
  }

  /** Reconnect the input used last time (called at start-up). */
  async restoreLive() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
      if (!p.source) return;
      const sources = await this.liveSources();
      const src = sources.find((s) => s.id === p.source.id && s.name === p.source.name) ?? sources.find((s) => s.name === p.source.name);
      if (src && src.kind !== 'browser-mic') await this.startLive(src);
    } catch {
      /* the device may be gone */
    }
  }

  get liveSensitivity() {
    return this.sensitivity;
  }

  setSensitivity(v: number) {
    this.sensitivity = Math.min(8, Math.max(0.1, v));
    this.analyzer.gain = this.sensitivity;
    this.savePrefs();
  }

  private savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ sensitivity: this.sensitivity, source: this.live && { id: this.live.id, name: this.live.name } }));
    } catch {
      /* storage unavailable */
    }
  }

  /** What the show hears right now. */
  features(now = performance.now() / 1000): AudioFeatures {
    if (!this.playing && !this.live) return SILENT;
    this.analyzer.update(now);
    return this.analyzer.features(now);
  }

  /** Live tempo is usable: live input on, no song playing, and the tracker has locked. */
  get liveTempoReady() {
    return !!this.live && !this.playing && this.analyzer.locked;
  }

  get recordStream(): MediaStream | undefined {
    return this.recordDest?.stream;
  }
}

function downsample(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += x[i * factor + j];
    out[i] = s / factor;
  }
  return out;
}
