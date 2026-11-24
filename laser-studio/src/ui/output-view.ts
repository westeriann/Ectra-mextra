// The output window: just the 3D view, fullscreen, following the editor.
// Put it on a projector or second screen for clients or the audience.

import { evaluate, initialLive, type Clock } from '../core/engine';
import { newShow } from '../core/show';
import type { Show } from '../core/types';
import { broadcast, onBroadcast } from '../platform/bridge';
import { CAMERA_PRESETS, Viewport } from '../render/viewport';
import { h } from './dom';
import type { SyncMessage } from './studio';

export function mountOutputView(root: HTMLElement) {
  document.body.classList.add('output-mode');
  const host = h('div', { class: 'output-host' });
  const help = h('div', { class: 'output-help' }, 'Double-click: fullscreen · F1–F5: camera · H: hide this');
  root.append(host, help);
  const vp = new Viewport(host, { interactive: false });
  let show: Show = newShow('empty');
  let state: SyncMessage | null = null;
  let receivedAt = performance.now();
  let connected = false;
  vp.syncShow(show, true);
  vp.setCamera('foh');

  onBroadcast((raw) => {
    const msg = raw as SyncMessage;
    if (msg?.type !== 'state') return;
    if (msg.show) {
      const first = !connected;
      show = msg.show;
      vp.syncShow(show);
      if (first) vp.setCamera('foh');
      connected = true;
    }
    state = msg;
    receivedAt = performance.now();
  });
  // Ask the editor for the full show.
  broadcast({ type: 'hello' });

  host.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
  window.addEventListener('keydown', (e) => {
    const cam = CAMERA_PRESETS.find((c) => c.key === e.key);
    if (cam) {
      e.preventDefault();
      vp.setCamera(cam.id);
    }
    if (e.key.toLowerCase() === 'h') help.hidden = !help.hidden;
  });
  setTimeout(() => (help.hidden = true), 6000);

  let last = performance.now();
  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = state;
    const since = (now - receivedAt) / 1000;
    const clock: Clock = s
      ? {
          wall: s.wall + since,
          time: s.time + since,
          beat: s.beat + (since * s.bpm) / 60,
          songTime: s.songTime === null ? null : s.songTime + (s.playing ? since : 0),
          level: s.level,
        }
      : { wall: now / 1000, time: now / 1000, beat: now / 1000 * 2, songTime: null, level: 0 };
    const frame = evaluate(show, s?.live ?? initialLive(), clock);
    vp.render(show, frame, clock.time, dt);
  };
  loop();
}
