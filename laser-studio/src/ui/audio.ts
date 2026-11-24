// Music playback for sync mode: decode a track, play/pause/seek it, and meter
// its level for audio-reactive effects. Can also listen to a microphone/line
// input so the show reacts to a live DJ without a loaded track.

import { analyze, mixdown, type Analysis } from '../core/analysis';

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private bins = new Uint8Array(0);
  playing = false;
  analysis: Analysis | null = null;
  /** Called when the track reaches its end. */
  onEnded: (() => void) | null = null;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.gain.connect(this.analyser);
      this.gain.connect(this.ctx.destination);
      this.gain.connect(this.recordDest);
    }
    return this.ctx;
  }

  get loaded() {
    return !!this.buffer;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  /** Decode a file and analyse tempo/beats. */
  async load(data: ArrayBuffer): Promise<Analysis> {
    const ctx = this.ensure();
    this.stop();
    this.buffer = await ctx.decodeAudioData(data.slice(0));
    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, i) => this.buffer!.getChannelData(i));
    // Analyse at half rate — plenty for tempo and much faster.
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

  /** Bass-weighted level 0..1 from whatever is playing (track or mic). */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.bins);
    // First ~16 bins ≈ 0–700 Hz at 44.1k: kick and bass.
    let lo = 0;
    for (let i = 1; i < 16; i++) lo += this.bins[i];
    let all = 0;
    for (let i = 1; i < this.bins.length; i += 4) all += this.bins[i];
    const l = (lo / 15 / 255) * 0.75 + (all / (this.bins.length / 4) / 255) * 0.25;
    return Math.min(1, Math.max(0, (l - 0.15) * 1.6));
  }

  async enableMic(): Promise<void> {
    const ctx = this.ensure();
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.micSource = ctx.createMediaStreamSource(this.micStream);
    // Mic goes to the analyser only — never to the speakers (feedback).
    this.micSource.connect(this.analyser!);
    await ctx.resume();
  }

  disableMic() {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micStream = null;
  }

  get micOn() {
    return !!this.micStream;
  }

  /** Audio stream for video recording. */
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
