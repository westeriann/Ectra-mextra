// Hardware I/O while the app runs: Art-Net and Ether Dream output every
// frame, and OSC / MIDI input mapped onto studio actions.

import { buildUniverses } from '../core/dmx';
import { beamsToPoints } from '../core/laserpath';
import { hardware, isDesktop, onBackend, type MidiMessage, type OscMessage } from '../platform/bridge';
import { toast } from './dom';
import type { Studio } from './studio';

export const MIDI_ACTIONS = [
  { id: 'go', label: 'GO (next cue)' },
  { id: 'back', label: 'Back' },
  { id: 'blackout', label: 'Blackout' },
  { id: 'master', label: 'Master fader (CC)' },
  { id: 'tap', label: 'Tap tempo' },
  { id: 'play', label: 'Play / pause' },
] as const;

export const OSC_ADDRESSES = [
  ['/ls/go', 'Next cue'],
  ['/ls/back', 'Previous cue'],
  ['/ls/cue <n | name>', 'Go to cue number or name'],
  ['/ls/pad <n> <0|1>', 'Press / release flash pad n'],
  ['/ls/master <0..1>', 'Master intensity'],
  ['/ls/blackout <0|1>', 'Blackout'],
  ['/ls/play · /ls/pause · /ls/stop', 'Transport'],
  ['/ls/seek <seconds>', 'Jump in the song'],
  ['/ls/bpm <bpm> · /ls/tap', 'Tempo'],
] as const;

export class Outputs {
  /** Last MIDI control seen — shown in the UI and used by "learn". */
  lastMidi = '';
  /** Action waiting for a MIDI control to be learned. */
  learning: string | null = null;
  onLearn: (() => void) | null = null;
  status = { artnet: '', osc: '', midi: '', dac: '' };
  private lastArtnet = 0;
  private lastDac = 0;
  private oscPort = -1;
  private midiPort: string | null = null;

  constructor(private studio: Studio) {
    studio.frameHooks.push(() => this.tick());
    onBackend<OscMessage>('osc', (m) => this.handleOsc(m));
    onBackend<MidiMessage>('midi', (m) => this.handleMidi(m));
    studio.store.subscribe((c) => c.topics.has('show') && void this.applySettings());
    void this.applySettings();
  }

  /** Start/stop listeners when settings change. */
  async applySettings() {
    if (!isDesktop) return;
    const o = this.studio.store.show.output;
    const wantOsc = o.osc.enabled ? o.osc.port : -1;
    if (wantOsc !== this.oscPort) {
      try {
        if (wantOsc < 0) await hardware.oscStop();
        else await hardware.oscStart(wantOsc);
        this.oscPort = wantOsc;
        this.status.osc = wantOsc < 0 ? '' : `Listening on UDP ${wantOsc}`;
      } catch (e) {
        this.oscPort = -1;
        this.status.osc = String(e);
        toast(String(e), 'error');
      }
    }
    const wantMidi = o.midi.enabled ? o.midi.port : null;
    if (wantMidi !== this.midiPort) {
      try {
        if (!wantMidi) await hardware.midiClose();
        else await hardware.midiOpen(wantMidi);
        this.midiPort = wantMidi;
        this.status.midi = wantMidi ? `Connected to ${wantMidi}` : '';
      } catch (e) {
        this.midiPort = null;
        this.status.midi = String(e);
        toast(String(e), 'error');
      }
    }
    if (!o.etherdream.enabled) void hardware.etherdreamStop();
  }

  private tick() {
    if (!isDesktop) return;
    const { store, frame } = this.studio;
    const o = store.show.output;
    const now = performance.now();
    if (o.artnet.enabled && now - this.lastArtnet >= 1000 / Math.max(1, o.artnet.rate)) {
      this.lastArtnet = now;
      const universes = buildUniverses(store.show, frame.fixtures, frame.looks);
      for (const [u, data] of universes) {
        hardware.artnetSend(o.artnet.host, u, data).then(
          () => (this.status.artnet = `Sending ${universes.size} universe(s) to ${o.artnet.host}`),
          (e) => (this.status.artnet = String(e)),
        );
      }
    }
    if (o.etherdream.enabled && now - this.lastDac >= 33) {
      this.lastDac = now;
      for (const f of store.show.fixtures) {
        if (!f.dac) continue;
        const beams = frame.fixtures.find((x) => x.fixtureId === f.id)?.beams ?? [];
        hardware.etherdreamFrame(f.dac, beamsToPoints(beams, f.scanAngle), o.etherdream.pps).then(
          () => (this.status.dac = 'Streaming'),
          (e) => (this.status.dac = String(e)),
        );
      }
    }
  }

  handleOsc(m: OscMessage) {
    const s = this.studio;
    const parts = m.address.split('/').filter(Boolean);
    if (parts[0] !== 'ls') return;
    const num = (i = 0) => Number(m.args[i] ?? 0);
    switch (parts[1]) {
      case 'go':
        return s.go();
      case 'back':
        return s.back();
      case 'cue': {
        const a = m.args[0] ?? parts[2];
        if (typeof a === 'number' || /^\d+$/.test(String(a))) return s.goCueByNumber(Number(a));
        const cue = s.store.show.cues.find((c) => c.name.toLowerCase() === String(a).toLowerCase());
        return cue && s.goCue(cue);
      }
      case 'pad': {
        const n = Number(parts[2] ?? m.args[0]);
        const down = parts[2] ? num(0) : num(1);
        const pad = s.store.show.pads[n - 1];
        if (!pad) return;
        return down > 0 ? s.padDown(pad.id) : s.padUp(pad.id);
      }
      case 'master':
        return s.setMaster(num());
      case 'blackout':
        return s.store.setLive({ blackout: m.args.length ? num() > 0 : !s.store.live.blackout });
      case 'play':
        return s.play();
      case 'pause':
        return s.pause();
      case 'stop':
        return s.stopTransport();
      case 'seek':
        return s.seek(num());
      case 'tap':
        return s.tap();
      case 'bpm':
        return num() > 20 && s.store.edit((sh) => (sh.bpm = num()), { coalesce: 'osc-bpm' });
    }
  }

  handleMidi(m: MidiMessage) {
    const s = this.studio;
    const midi = s.store.show.output.midi;
    if (m.kind === 'timecode') {
      if (!midi.timecode || !s.audio.loaded) return;
      // Chase timecode: jump if we've drifted, and follow its play state.
      if (Math.abs(s.audio.time - m.seconds) > 0.15) s.seek(m.seconds);
      if (!s.audio.playing) s.play();
      return;
    }
    const key = m.kind === 'note' ? `note:${m.note}` : `cc:${m.controller}`;
    const value = m.kind === 'note' ? m.velocity : m.value;
    this.lastMidi = `${key} (${value})`;
    if (this.learning) {
      if (value === 0) return;
      const action = this.learning;
      this.learning = null;
      if (action.startsWith('pad:')) {
        const id = action.slice(4);
        s.store.edit((sh) => (sh.pads.find((p) => p.id === id)!.midi = key));
      } else s.store.edit((sh) => (sh.output.midi.map[action] = key));
      toast(`Learned ${key}`);
      this.onLearn?.();
      return;
    }
    const pad = s.store.show.pads.find((p) => p.midi === key);
    if (pad) return value > 0 ? s.padDown(pad.id) : s.padUp(pad.id);
    const action = Object.entries(midi.map).find(([, k]) => k === key)?.[0];
    if (!action) return;
    if (action === 'master') return s.setMaster(value / 127);
    if (value === 0) return; // note-offs only matter for pads
    if (action === 'go') s.go();
    else if (action === 'back') s.back();
    else if (action === 'blackout') s.toggleBlackout();
    else if (action === 'tap') s.tap();
    else if (action === 'play') s.togglePlay();
  }

}
