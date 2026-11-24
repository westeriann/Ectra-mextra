// The 🎤 Audio control in the top bar: one click to pick what to listen to,
// a live meter, the detected tempo, and the reactions that make every look
// move with the music.

import { REACT_PRESETS, REACT_SOURCES, REACT_TARGETS, presetOf, routeFromPreset, type ReactSource, type ReactTarget } from '../core/react';
import { uid } from '../core/util';
import { isDesktop } from '../platform/bridge';
import type { LiveSource } from './audio';
import { button, clear, h, select, slider, toast, toggle } from './dom';
import type { Studio } from './studio';

export function mountAudioControl(host: HTMLElement, studio: Studio) {
  const { store, audio } = studio;
  const meterBars = ['bass', 'mid', 'treble'].map(() => h('i'));
  const label = h('span', { class: 'au-label' }, 'Audio');
  const btn = h(
    'button',
    { class: 'btn audio-btn', title: 'Live audio: listen to a mic, line in or system audio, and set how the lasers react', 'aria-haspopup': 'dialog' },
    h('span', { class: 'au-icon' }, '🎤'),
    label,
    h('span', { class: 'au-meter' }, ...meterBars),
  );
  const panel = h('div', { class: 'audio-panel', role: 'dialog', 'aria-label': 'Live audio', hidden: true });
  host.append(h('div', { class: 'menu-wrap' }, btn, panel));

  let sources: LiveSource[] = [];
  let busy = false;
  const open = async () => {
    panel.hidden = false;
    sources = await audio.liveSources();
    render();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) void open();
    else panel.hidden = true;
  });
  window.addEventListener('ls:open-audio', () => void open());
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && !btn.contains(e.target as Node)) panel.hidden = true;
  });

  async function pick(id: string) {
    busy = true;
    render();
    try {
      if (id === 'off') await audio.stopLive();
      else {
        const src = sources.find((s) => s.id === id);
        if (src) await audio.startLive(src);
        // First time on: switch on two reactions so it's obvious it works.
        if (!store.show.audio.routes.length) {
          store.edit((s) => (s.audio.routes = [routeFromPreset('kick-pump')!, routeFromPreset('bass-breathe')!]));
          toast('Listening — Kick pump and Bass breathes are on. Try the others below.');
        }
      }
    } catch (e) {
      toast(`Couldn't open that input: ${e instanceof Error ? e.message : e}`, 'error');
    }
    busy = false;
    render();
  }

  function togglePreset(id: string, on: boolean) {
    store.edit((s) => {
      const existing = s.audio.routes.find((r) => presetOf(r) === id);
      if (on && !existing) s.audio.routes.push(routeFromPreset(id)!);
      else if (existing) existing.on = on;
    });
  }

  // Live readouts, updated every frame without rebuilding the panel.
  const bars: Record<string, HTMLElement> = {};
  const lamps: Record<string, HTMLElement> = {};
  const tempoEl = h('span', { class: 'au-tempo' });

  const render = () => {
    const a = store.show.audio;
    const liveId = audio.live?.id ?? 'off';
    const inputs = sources.filter((s) => s.kind !== 'system');
    const system = sources.filter((s) => s.kind === 'system');
    const meter = h(
      'div',
      { class: 'au-meters' },
      ...(['bass', 'mid', 'treble', 'level'] as const).map((k) => {
        bars[k] = h('i');
        return h('div', { class: 'au-bar' }, h('span', null, { bass: 'Bass', mid: 'Mids', treble: 'Treble', level: 'Level' }[k]), h('div', { class: 'au-track' }, bars[k]));
      }),
      h(
        'div',
        { class: 'au-lamps' },
        ...(['kick', 'snare', 'hat', 'beat'] as const).map((k) => {
          lamps[k] = h('span', { class: 'au-lamp' });
          return h('span', { class: 'au-lamp-wrap' }, lamps[k], { kick: 'Kick', snare: 'Snare', hat: 'Hats', beat: 'Beat' }[k]);
        }),
      ),
    );
    clear(
      panel,
      h('div', { class: 'panel-head' }, h('h2', null, 'Live audio'), button('✕', () => (panel.hidden = true), { class: 'btn btn-xs', title: 'Close' })),
      h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Listen to'),
        h(
          'select',
          { disabled: busy, onchange: (e: Event) => void pick((e.target as HTMLSelectElement).value) },
          h('option', { value: 'off', selected: liveId === 'off' }, 'Off'),
          system.length ? h('optgroup', { label: 'System audio (what this PC plays)' }, ...system.map((s) => h('option', { value: s.id, selected: s.id === liveId }, s.name))) : null,
          inputs.length ? h('optgroup', { label: 'Microphones & line inputs' }, ...inputs.map((s) => h('option', { value: s.id, selected: s.id === liveId }, s.name))) : null,
        ),
      ),
      !isDesktop ? h('p', { class: 'hint' }, 'In the desktop app you can also listen to system audio (Spotify, DJ software…) on Windows.') : !system.length && !inputs.length ? h('p', { class: 'hint' }, 'No audio devices found.') : null,
      studio.audio.playing ? h('p', { class: 'hint' }, 'A song is playing in the Show tab — reactions follow the song right now.') : null,
      slider({
        label: 'Sensitivity',
        value: audio.liveSensitivity,
        min: 0.1,
        max: 8,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
        title: 'Boost quiet inputs. Levels also adjust automatically.',
        onInput: (v) => audio.setSensitivity(v),
      }),
      meter,
      h(
        'div',
        { class: 'au-tempo-row' },
        tempoEl,
        button('Tap', () => studio.tap(), { class: 'btn btn-sm', title: 'Tap along to teach it the tempo and the downbeat (T)' }),
        button('×2', () => audio.analyzer.setBpm(audio.analyzer.bpm * 2, performance.now() / 1000), { class: 'btn btn-sm', title: 'Double the detected tempo' }),
        button('÷2', () => audio.analyzer.setBpm(audio.analyzer.bpm / 2, performance.now() / 1000), { class: 'btn btn-sm', title: 'Halve the detected tempo' }),
      ),
      toggle({ label: 'Beat-synced effects follow the live tempo', value: a.followTempo, onChange: (v) => store.edit((s) => (s.audio.followTempo = v)) }),
      h('h3', null, 'Reactions'),
      h('p', { class: 'hint' }, 'These work on every look, on top of your cues.'),
      h(
        'div',
        { class: 'au-presets' },
        ...REACT_PRESETS.map((p) => {
          const r = a.routes.find((x) => presetOf(x) === p.id);
          const on = !!r?.on;
          return h('button', { class: `au-preset ${on ? 'on' : ''}`, title: p.hint, 'aria-pressed': String(on), onclick: () => togglePreset(p.id, !on) }, p.label);
        }),
      ),
      slider({ label: 'Overall amount', value: a.amount, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => store.edit((s) => (s.audio.amount = v), { coalesce: 'au-amount', source: 'audio-panel' }) }),
      h('details', { class: 'au-custom', open: a.routes.some((r) => !presetOf(r)) },
        h('summary', null, `Fine-tune (${a.routes.length} reaction${a.routes.length === 1 ? '' : 's'})`),
        ...a.routes.map((r, i) =>
          h(
            'div',
            { class: 'au-route' },
            h('input', { type: 'checkbox', checked: r.on, title: 'On', onchange: (e: Event) => store.edit((s) => (s.audio.routes[i].on = (e.target as HTMLInputElement).checked)) }),
            select({ value: r.source, options: Object.entries(REACT_SOURCES).map(([value, label]) => ({ value: value as ReactSource, label })), onChange: (v) => store.edit((s) => (s.audio.routes[i].source = v)) }),
            h('span', { class: 'au-arrow' }, '→'),
            select({ value: r.target, options: Object.entries(REACT_TARGETS).map(([value, label]) => ({ value: value as ReactTarget, label })), onChange: (v) => store.edit((s) => (s.audio.routes[i].target = v)) }),
            h('input', {
              type: 'range',
              min: '0',
              max: '1',
              step: '0.01',
              value: String(r.amount),
              title: 'Amount',
              oninput: (e: Event) => store.edit((s) => (s.audio.routes[i].amount = Number((e.target as HTMLInputElement).value)), { coalesce: `au-${r.id}`, source: 'audio-panel' }),
            }),
            button('✕', () => store.edit((s) => s.audio.routes.splice(i, 1)), { class: 'btn btn-xs', title: 'Remove' }),
          ),
        ),
        button('＋ Add reaction', () => store.edit((s) => s.audio.routes.push({ id: uid('rt'), source: 'kick', target: 'tilt', amount: 0.4, on: true })), { class: 'btn btn-sm' }),
      ),
    );
  };

  audio.onLiveChange = () => {
    if (!panel.hidden) render();
  };
  store.subscribe((c) => {
    if (!panel.hidden && c.topics.has('show') && c.source !== 'audio-panel') render();
  });

  // Every frame: the meters, the button's mini meter and the tempo readout.
  const tick = () => {
    requestAnimationFrame(tick);
    const f = studio.heard;
    const on = !!audio.live || audio.playing;
    btn.classList.toggle('on', on);
    label.textContent = audio.live ? (studio.followingLive ? `${audio.analyzer.bpm.toFixed(1)}` : 'Live') : 'Audio';
    [f.bass, f.mid, f.treble].forEach((v, i) => (meterBars[i].style.transform = `scaleY(${Math.max(0.08, v)})`));
    if (panel.hidden) return;
    for (const k of ['bass', 'mid', 'treble', 'level'] as const) if (bars[k]) bars[k].style.transform = `scaleX(${f[k]})`;
    for (const k of ['kick', 'snare', 'hat', 'beat'] as const) if (lamps[k]) lamps[k].style.opacity = String(0.15 + 0.85 * f[k]);
    const az = audio.analyzer;
    tempoEl.textContent = !audio.live
      ? audio.playing
        ? 'Following the song in the Show tab'
        : 'Pick something to listen to'
      : !f.active
        ? 'No sound coming in…'
        : az.locked
          ? `${az.bpm.toFixed(1)} BPM · locked`
          : 'Listening for the beat…';
  };
  tick();
}
