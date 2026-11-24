// Setup mode: outputs and control inputs.

import { PROFILE_CHANNELS } from '../core/dmx';
import { hardware, isDesktop, type DacInfo } from '../platform/bridge';
import type { Quality } from '../render/viewport';
import { button, clear, h, numberInput, section, select, textInput, toggle } from './dom';
import { MIDI_ACTIONS, OSC_ADDRESSES, type Outputs } from './outputs';
import type { Studio } from './studio';

export function mountSetup(root: HTMLElement, studio: Studio, outputs: Outputs) {
  const { store } = studio;
  let midiPorts: string[] = [];
  let dacs: DacInfo[] = [];
  let scanning = false;
  let quality: Quality = 'high';
  const edit = (fn: Parameters<typeof store.edit>[0]) => store.edit(fn, { source: 'setup' });
  const statusEls: Record<string, HTMLElement> = {};
  const status = (k: keyof Outputs['status']) => (statusEls[k] = h('p', { class: 'status' }, outputs.status[k]));

  async function refreshMidi() {
    midiPorts = await hardware.midiPorts().catch(() => []);
    render();
  }

  const render = () => {
    const o = store.show.output;
    clear(
      root,
      h('div', { class: 'panel-head' }, h('h2', null, 'Setup')),
      !isDesktop
        ? h('div', { class: 'notice' }, 'You are running in a browser. Hardware outputs (Art-Net, OSC, MIDI, laser DACs) and native file dialogs need the desktop app — see README for how to build it.')
        : null,
      h(
        'div',
        { class: 'setup-grid' },
        section(
          'Art-Net (DMX) output',
          h('p', { class: 'hint' }, 'Sends each laser’s look as DMX so a console, visualiser or real DMX lasers can follow the show.'),
          toggle({ label: 'Enabled', value: o.artnet.enabled, onChange: (v) => edit((s) => (s.output.artnet.enabled = v)) }),
          textInput({ label: 'Destination IP', value: o.artnet.host, placeholder: '255.255.255.255 = broadcast', onChange: (v) => edit((s) => (s.output.artnet.host = v.trim() || '255.255.255.255')) }),
          numberInput({ label: 'Frames / second', value: o.artnet.rate, step: 1, min: 1, max: 44, onChange: (v) => edit((s) => (s.output.artnet.rate = Math.max(1, Math.min(44, v)))) }),
          h('p', { class: 'hint' }, `10 channels per laser: ${PROFILE_CHANNELS.join(' · ')}. Set each laser’s universe and address in the Stage tab.`),
          status('artnet'),
        ),
        section(
          'OSC input',
          h('p', { class: 'hint' }, 'Fire cues from TouchOSC, QLab, Ableton, Companion, etc.'),
          toggle({ label: 'Enabled', value: o.osc.enabled, onChange: (v) => edit((s) => (s.output.osc.enabled = v)) }),
          numberInput({ label: 'UDP port', value: o.osc.port, step: 1, min: 1024, max: 65535, onChange: (v) => edit((s) => (s.output.osc.port = Math.round(v))) }),
          h('table', { class: 'osc-table' }, ...OSC_ADDRESSES.map(([a, d]) => h('tr', null, h('td', null, h('code', null, a)), h('td', null, d)))),
          status('osc'),
        ),
        section(
          'MIDI input & timecode',
          toggle({ label: 'Enabled', value: o.midi.enabled, onChange: (v) => edit((s) => (s.output.midi.enabled = v)) }),
          h(
            'div',
            { class: 'row' },
            select({ label: 'Device', value: o.midi.port ?? '', options: [{ value: '', label: midiPorts.length ? '(choose)' : '(none found)' }, ...midiPorts.map((p) => ({ value: p, label: p }))], onChange: (v) => edit((s) => (s.output.midi.port = v || null)) }),
            button('↻', refreshMidi, { class: 'btn btn-icon', title: 'Refresh devices' }),
          ),
          toggle({ label: 'Chase MIDI timecode (MTC)', value: o.midi.timecode, onChange: (v) => edit((s) => (s.output.midi.timecode = v)), title: 'Follow a DAW or playback rig: the song seeks and plays along with incoming timecode' }),
          h('div', { class: 'list-title' }, 'Mappings', h('span', { class: 'grow' }), h('span', { class: 'hint' }, outputs.lastMidi ? `last: ${outputs.lastMidi}` : '')),
          ...MIDI_ACTIONS.map((a) => learnRow(a.label, o.midi.map[a.id], a.id, () => edit((s) => delete s.output.midi.map[a.id]))),
          ...store.show.pads.map((p, i) => learnRow(`Pad ${i + 1} · ${p.label}`, p.midi, `pad:${p.id}`, () => edit((s) => delete s.pads[i].midi))),
          status('midi'),
        ),
        section(
          'Laser DACs (Ether Dream)',
          h('p', { class: 'hint' }, 'Drive real laser projectors over the network. Assign a DAC to a laser in the Stage tab. Experimental: implemented to the published protocol, not yet tested with hardware.'),
          h('div', { class: 'notice warn' }, 'Laser safety: never scan beams into an audience without proper safety zones, a trained operator and any licence your country requires.'),
          toggle({ label: 'Enabled', value: o.etherdream.enabled, onChange: (v) => edit((s) => (s.output.etherdream.enabled = v)) }),
          numberInput({ label: 'Points / second', value: o.etherdream.pps, step: 1000, min: 1000, max: 100000, onChange: (v) => edit((s) => (s.output.etherdream.pps = Math.round(v))) }),
          button(scanning ? 'Scanning…' : 'Find DACs on the network', async () => {
            scanning = true;
            render();
            dacs = await hardware.etherdreamScan().catch(() => []);
            scanning = false;
            render();
          }, { disabled: scanning || !isDesktop }),
          ...dacs.map((d) => h('p', { class: 'status' }, `${d.ip} — ${d.mac} (hw ${d.hwRevision}, sw ${d.swRevision})`)),
          status('dac'),
        ),
        section(
          'Display',
          select({
            label: 'Render quality',
            value: quality,
            options: [{ value: 'high', label: 'High (bloom, full resolution)' }, { value: 'medium', label: 'Medium (bloom, 1× resolution)' }, { value: 'low', label: 'Low (no bloom) — for slow GPUs' }],
            onChange: (v) => {
              quality = v;
              studio.viewport?.setQuality(v);
            },
          }),
        ),
      ),
    );
  };

  function learnRow(label: string, current: string | undefined, action: string, clearIt: () => void) {
    const learning = outputs.learning === action;
    return h(
      'div',
      { class: 'learn-row' },
      h('span', null, label),
      h('code', null, current ?? '—'),
      button(learning ? 'Move a control…' : 'Learn', () => {
        outputs.learning = learning ? null : action;
        render();
      }, { class: `btn btn-xs ${learning ? 'on' : ''}`, disabled: !isDesktop }),
      current ? button('✕', clearIt, { class: 'btn btn-xs' }) : null,
    );
  }

  outputs.onLearn = render;
  render();
  if (isDesktop) void refreshMidi();
  store.subscribe((c) => c.topics.has('show') && c.source !== 'setup' && render());
  setInterval(() => {
    for (const [k, el] of Object.entries(statusEls)) el.textContent = outputs.status[k as keyof Outputs['status']];
  }, 500);
}
