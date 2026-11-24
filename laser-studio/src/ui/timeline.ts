// Show mode: a music timeline with waveform, beat grid, a cue lane and a hits
// lane, plus the music/sync panel and a cue palette.

import { AUTO_PARAM_IDS, AUTO_PARAMS, formatAutoValue, laneValue, type AutoParam, type AutoPoint } from '../core/automation';
import { snapToGrid } from '../core/engine';
import { VIBES } from '../core/generate';
import type { HitKind } from '../core/types';
import { clamp, fmtTime, uid } from '../core/util';
import { button, clear, h, modal, numberInput, section, select, slider, toast, toggle } from './dom';
import type { Studio } from './studio';

const RULER = 22;
const WAVE = 74;
const CUE_LANE = 40;
const HIT_LANE = 28;
const AUTO_TOP = RULER + WAVE + CUE_LANE + HIT_LANE;
const LANE_H = 52;
const LANE_PAD = 7;
const LANE_COLORS: Record<AutoParam, string> = {
  intensity: '#facc15',
  speed: '#22d3ee',
  size: '#a78bfa',
  spread: '#f472b6',
  pan: '#34d399',
  tilt: '#fb923c',
  hue: '#e879f9',
};
const HIT_COLORS: Record<HitKind, string> = { flash: '#ffffff', strobe: '#facc15', blackout: '#64748b' };

export function mountTimeline(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const canvas = h('canvas', { class: 'timeline-canvas', tabindex: '0' });
  const empty = h(
    'div',
    { class: 'timeline-empty' },
    h('p', { class: 'drop-hint' }, 'Drop a song anywhere — or'),
    button('Load music…', () => studio.loadMusic(), { class: 'btn btn-primary' }),
    h('p', null, 'Laser Studio can design a whole show from it.'),
    h('p', { class: 'hint' }, 'Tempo and beats are detected automatically. Cues snap to the beat grid.'),
  );
  const zoomLabel = h('span', { class: 'hint' });
  const toolbar = h(
    'div',
    { class: 'timeline-toolbar' },
    button('Load music…', () => studio.loadMusic(), { class: 'btn btn-sm' }),
    h('span', { class: 'sep' }),
    button('＋ Cue at playhead', () => addCueAt(studio.songTime ?? 0), { class: 'btn btn-sm', title: 'Adds the cue selected in the palette (or the running cue)' }),
    button('Flash', () => studio.addHit('flash'), { class: 'btn btn-sm', title: 'Add a flash hit at the playhead (F)' }),
    button('Strobe', () => studio.addHit('strobe'), { class: 'btn btn-sm', title: 'Add a strobe hit at the playhead (G)' }),
    button('Blackout', () => studio.addHit('blackout'), { class: 'btn btn-sm', title: 'Add a blackout hit at the playhead (K)' }),
    button('Delete', () => deleteSelected(), { class: 'btn btn-sm', title: 'Delete selected item (Del)' }),
    h('span', { class: 'sep' }),
    toggle({ label: 'Snap', value: true, onChange: (v) => (snap = v) }),
    toggle({ label: 'Follow', value: true, onChange: (v) => (follow = v) }),
    h('span', { class: 'grow' }),
    button('−', () => setZoom(zoom / 1.5), { class: 'btn btn-icon', title: 'Zoom out' }),
    zoomLabel,
    button('+', () => setZoom(zoom * 1.5), { class: 'btn btn-icon', title: 'Zoom in (Ctrl+wheel)' }),
  );
  const wrap = h('div', { class: 'timeline-wrap' }, canvas, empty);
  root.append(toolbar, wrap);

  let zoom = 40; // px per second
  let scroll = 0; // seconds at left edge
  let snap = true;
  let follow = true;
  let drag: { kind: 'cue' | 'hit' | 'point'; id: string; laneId?: string; offset: number; moved: boolean } | null = null;
  let scrubbing = false;
  /** Counts drag gestures so each drag is exactly one undo step. */
  let dragNo = 0;
  const ctx = canvas.getContext('2d')!;

  const setZoom = (z: number) => {
    const center = scroll + canvas.clientWidth / zoom / 2;
    zoom = clamp(z, 4, 600);
    scroll = Math.max(0, center - canvas.clientWidth / zoom / 2);
    zoomLabel.textContent = `${Math.round(zoom)} px/s`;
  };
  setZoom(zoom);

  const music = () => store.show.music;
  const xToTime = (x: number) => scroll + x / zoom;
  const timeToX = (t: number) => (t - scroll) * zoom;
  const snapT = (t: number, e?: MouseEvent) => {
    const m = music();
    if (!m || !snap || e?.altKey) return Math.max(0, t);
    return snapToGrid(t, m.bpm, m.offset, zoom > 120 ? 4 : zoom > 50 ? 2 : 1);
  };

  function addCueAt(t: number, cueId?: string) {
    const id = cueId ?? store.sel.cueId ?? studio.frame.activeCueId ?? store.show.cues[0]?.id;
    if (!id || !music()) return;
    const time = snapT(t);
    const entry = { id: uid('tc'), time, cueId: id };
    store.edit((s) => {
      s.timeline.cues = s.timeline.cues.filter((e) => Math.abs(e.time - time) > 0.01);
      s.timeline.cues.push(entry);
      s.timeline.cues.sort((a, b) => a.time - b.time);
    });
    store.setSel({ timeline: { kind: 'cue', id: entry.id } });
    studio.followTimeline();
  }

  function deleteSelected() {
    const t = store.sel.timeline;
    if (!t) return;
    store.edit((s) => {
      if (t.kind === 'cue') s.timeline.cues = s.timeline.cues.filter((e) => e.id !== t.id);
      else if (t.kind === 'hit') s.timeline.hits = s.timeline.hits.filter((e) => e.id !== t.id);
      else {
        const lane = s.timeline.lanes.find((l) => l.id === t.laneId);
        if (lane) lane.points = lane.points.filter((p) => p.id !== t.id);
      }
    });
    store.setSel({ timeline: null });
  }

  function hitTest(x: number, y: number): { kind: 'cue' | 'hit'; id: string; time: number } | null {
    const t = xToTime(x);
    if (y >= RULER + WAVE && y < RULER + WAVE + CUE_LANE) {
      const sorted = [...store.show.timeline.cues].sort((a, b) => a.time - b.time);
      for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].time <= t) return { kind: 'cue', id: sorted[i].id, time: sorted[i].time };
    } else if (y >= RULER + WAVE + CUE_LANE && y < AUTO_TOP) {
      for (const hit of store.show.timeline.hits) {
        const x0 = timeToX(hit.time);
        const x1 = Math.max(x0 + 6, timeToX(hit.time + hit.duration));
        if (x >= x0 - 3 && x <= x1) return { kind: 'hit', id: hit.id, time: hit.time };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ automation lanes
  const lanes = () => store.show.timeline.lanes;
  const laneTop = (i: number) => AUTO_TOP + i * LANE_H;
  function laneAt(y: number) {
    const i = Math.floor((y - AUTO_TOP) / LANE_H);
    const lane = y >= AUTO_TOP ? lanes()[i] : undefined;
    return lane ? { lane, i, top: laneTop(i) } : null;
  }
  const valueToY = (param: AutoParam, v: number, top: number) => {
    const p = AUTO_PARAMS[param];
    return top + LANE_PAD + (1 - (v - p.min) / (p.max - p.min)) * (LANE_H - LANE_PAD * 2);
  };
  const yToValue = (param: AutoParam, y: number, top: number) => {
    const p = AUTO_PARAMS[param];
    const u = clamp(1 - (y - top - LANE_PAD) / (LANE_H - LANE_PAD * 2), 0, 1);
    const v = p.min + u * (p.max - p.min);
    // Snap to the neutral value when close — easy to get back to "no change".
    return Math.abs(v - p.neutral) < (p.max - p.min) * 0.03 ? p.neutral : Math.round(v * 1000) / 1000;
  };
  function pointAt(x: number, y: number) {
    const hit = laneAt(y);
    if (!hit) return null;
    for (const p of hit.lane.points) {
      if (Math.hypot(timeToX(p.time) - x, valueToY(hit.lane.param, p.value, hit.top) - y) < 7) return { ...hit, point: p };
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!music()) return;
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < RULER + WAVE) {
      scrubbing = true;
      studio.seek(Math.max(0, xToTime(x)));
      return;
    }
    const lh = laneAt(y);
    if (lh) {
      if (x < 70) return; // lane label
      let pt = pointAt(x, y)?.point;
      if (!pt) {
        // Click on empty lane space adds a point there.
        pt = { id: uid('pt'), time: snapT(xToTime(x), e), value: yToValue(lh.lane.param, y, lh.top), curve: 'linear' };
        const added = pt;
        store.edit((s) => {
          const lane = s.timeline.lanes.find((l) => l.id === lh.lane.id)!;
          lane.points.push(added);
          lane.points.sort((a, b) => a.time - b.time);
        }, { source: 'timeline' });
      }
      store.setSel({ timeline: { kind: 'point', id: pt.id, laneId: lh.lane.id } });
      dragNo++;
      drag = { kind: 'point', id: pt.id, laneId: lh.lane.id, offset: 0, moved: false };
      return;
    }
    const hit = hitTest(x, y);
    if (hit) {
      store.setSel({ timeline: { kind: hit.kind, id: hit.id } });
      dragNo++;
      drag = { kind: hit.kind, id: hit.id, offset: xToTime(x) - hit.time, moved: false };
    } else store.setSel({ timeline: null });
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (scrubbing) {
      studio.seek(Math.max(0, xToTime(x)));
      return;
    }
    if (!drag) {
      const y = e.clientY - r.top;
      const hit = hitTest(x, y) ?? pointAt(x, y);
      canvas.style.cursor = hit ? 'grab' : y < RULER + WAVE ? 'text' : laneAt(y) ? 'crosshair' : 'default';
      return;
    }
    const t = snapT(xToTime(x) - drag.offset, e);
    const d = drag;
    if (d.kind === 'point') {
      const li = lanes().findIndex((l) => l.id === d.laneId);
      if (li < 0) return;
      const value = yToValue(lanes()[li].param, e.clientY - r.top, laneTop(li));
      store.edit(
        (s) => {
          const lane = s.timeline.lanes[li];
          const p = lane.points.find((q) => q.id === d.id);
          if (p) Object.assign(p, { time: t, value });
          lane.points.sort((a, b) => a.time - b.time);
        },
        { coalesce: `drag-${d.id}-${dragNo}`, source: 'timeline', gesture: true },
      );
      drag.moved = true;
      return;
    }
    store.edit(
      (s) => {
        const list = d.kind === 'cue' ? s.timeline.cues : s.timeline.hits;
        const item = list.find((i) => i.id === d.id);
        if (item) item.time = t;
        if (d.kind === 'cue') s.timeline.cues.sort((a, b) => a.time - b.time);
      },
      { coalesce: `drag-${d.id}-${dragNo}`, source: 'timeline', gesture: true },
    );
    drag.moved = true;
  });
  const endDrag = () => {
    drag = null;
    scrubbing = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const y = e.clientY - r.top;
    const t = xToTime(e.clientX - r.left);
    const pt = pointAt(e.clientX - r.left, y);
    if (pt) {
      // Double-click a point to delete it.
      store.edit((s) => {
        const lane = s.timeline.lanes.find((l) => l.id === pt.lane.id)!;
        lane.points = lane.points.filter((p) => p.id !== pt.point.id);
      });
      store.setSel({ timeline: null });
      return;
    }
    if (laneAt(y)) return;
    if (y >= RULER + WAVE + CUE_LANE) {
      const time = snapT(t);
      store.edit((s) => s.timeline.hits.push({ id: uid('hit'), time, duration: 0.4, kind: 'flash' }));
    } else if (y >= RULER + WAVE) addCueAt(t);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = canvas.getBoundingClientRect();
        const at = xToTime(e.clientX - r.left);
        zoom = clamp(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 4, 600);
        scroll = Math.max(0, at - (e.clientX - r.left) / zoom);
        zoomLabel.textContent = `${Math.round(zoom)} px/s`;
      } else {
        scroll = Math.max(0, scroll + (e.deltaX + e.deltaY) / zoom);
        follow = false;
      }
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      deleteSelected();
    }
  });
  // Drop cues from the palette.
  canvas.addEventListener('dragover', (e) => e.preventDefault());
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData('application/x-cue');
    if (!id) return;
    const r = canvas.getBoundingClientRect();
    addCueAt(xToTime(e.clientX - r.left), id);
  });

  function draw() {
    requestAnimationFrame(draw);
    const m = music();
    const hasAudio = !!m && studio.audio.loaded;
    empty.style.display = m ? 'none' : '';
    canvas.style.display = m ? '' : 'none';
    if (!m) return;
    const w = canvas.clientWidth;
    const dpr = devicePixelRatio || 1;
    const HEIGHT = AUTO_TOP + lanes().length * LANE_H;
    canvas.style.height = `${HEIGHT}px`;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
    }
    const now = studio.songTime ?? 0;
    if (follow && studio.audio.playing) {
      const px = timeToX(now);
      if (px > w * 0.8 || px < 0) scroll = Math.max(0, now - (w * 0.2) / zoom);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(0, 0, w, HEIGHT);
    ctx.fillStyle = '#10131c';
    ctx.fillRect(0, RULER + WAVE, w, CUE_LANE);
    ctx.fillStyle = '#0d1018';
    ctx.fillRect(0, RULER + WAVE + CUE_LANE, w, HIT_LANE);

    // Beat grid.
    const beatLen = 60 / m.bpm;
    const t0 = xToTime(0);
    const t1 = xToTime(w);
    const firstBeat = Math.floor((t0 - m.offset) / beatLen);
    const showBeats = beatLen * zoom > 6;
    ctx.font = '10px system-ui, sans-serif';
    for (let b = firstBeat; m.offset + b * beatLen <= t1; b++) {
      const t = m.offset + b * beatLen;
      if (t < 0) continue;
      const x = Math.round(timeToX(t)) + 0.5;
      const isBar = ((b % m.beatsPerBar) + m.beatsPerBar) % m.beatsPerBar === 0;
      if (!isBar && !showBeats) continue;
      ctx.strokeStyle = isBar ? 'rgba(140,160,255,0.28)' : 'rgba(140,160,255,0.09)';
      ctx.beginPath();
      ctx.moveTo(x, isBar ? 0 : RULER);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
      const bar = Math.floor(b / m.beatsPerBar) + 1;
      if (isBar && (zoom * beatLen * m.beatsPerBar > 26 || bar % 4 === 1)) {
        ctx.fillStyle = '#7f8bb3';
        ctx.fillText(String(bar), x + 3, 14);
      }
    }

    // Waveform.
    const peaks = studio.audio.analysis?.peaks;
    if (hasAudio && peaks) {
      const n = peaks.length / 2;
      const mid = RULER + WAVE / 2;
      ctx.fillStyle = 'rgba(76,201,240,0.55)';
      for (let x = 0; x < w; x++) {
        const i = Math.floor((xToTime(x) / m.duration) * n);
        if (i < 0 || i >= n) continue;
        const lo = peaks[i * 2];
        const hi = peaks[i * 2 + 1];
        ctx.fillRect(x, mid - hi * (WAVE / 2 - 4), 1, Math.max(1, (hi - lo) * (WAVE / 2 - 4)));
      }
    } else {
      ctx.fillStyle = '#7f8bb3';
      ctx.fillText(`Music “${m.name}” not loaded — use Load music to relink it`, 10, RULER + WAVE / 2);
    }

    // Cue blocks.
    const cues = [...store.show.timeline.cues].sort((a, b) => a.time - b.time);
    const byId = new Map(store.show.cues.map((c) => [c.id, c]));
    const end = Math.max(m.duration, (cues.at(-1)?.time ?? 0) + 8);
    ctx.font = '12px system-ui, sans-serif';
    cues.forEach((e, i) => {
      const cue = byId.get(e.cueId);
      const x0 = timeToX(e.time);
      const x1 = timeToX(cues[i + 1]?.time ?? end);
      if (x1 < 0 || x0 > w) return;
      const sel = store.sel.timeline?.kind === 'cue' && store.sel.timeline.id === e.id;
      ctx.fillStyle = cue?.tag ?? '#666';
      ctx.globalAlpha = 0.28;
      ctx.fillRect(x0, RULER + WAVE + 4, x1 - x0 - 1, CUE_LANE - 8);
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, RULER + WAVE + 4, 3, CUE_LANE - 8);
      if (cue && cue.fade > 0) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, RULER + WAVE + CUE_LANE - 4);
        ctx.lineTo(x0 + cue.fade * zoom, RULER + WAVE + 4);
        ctx.lineTo(x0, RULER + WAVE + 4);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, RULER + WAVE + 5, x1 - x0 - 3, CUE_LANE - 10);
        ctx.lineWidth = 1;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, RULER + WAVE, Math.max(0, x1 - x0 - 4), CUE_LANE);
      ctx.clip();
      ctx.fillStyle = '#e8ecff';
      ctx.fillText(cue?.name ?? '(deleted cue)', Math.max(x0 + 8, 50), RULER + WAVE + CUE_LANE / 2 + 4);
      ctx.restore();
    });

    // Hits.
    for (const hit of store.show.timeline.hits) {
      const x0 = timeToX(hit.time);
      const x1 = Math.max(x0 + 6, timeToX(hit.time + hit.duration));
      if (x1 < 0 || x0 > w) continue;
      const y = RULER + WAVE + CUE_LANE + 5;
      ctx.fillStyle = HIT_COLORS[hit.kind];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0, y, x1 - x0, HIT_LANE - 10);
      ctx.globalAlpha = 1;
      if (store.sel.timeline?.kind === 'hit' && store.sel.timeline.id === hit.id) {
        ctx.strokeStyle = '#4cc9f0';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 - 1, y - 1, x1 - x0 + 2, HIT_LANE - 8);
        ctx.lineWidth = 1;
      }
    }

    // Automation lanes.
    lanes().forEach((lane, li) => {
      const top = laneTop(li);
      const p = AUTO_PARAMS[lane.param];
      ctx.fillStyle = li % 2 ? '#0c0f17' : '#0e111a';
      ctx.fillRect(0, top, w, LANE_H);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(0, top + 0.5);
      ctx.lineTo(w, top + 0.5);
      ctx.stroke();
      // Neutral (no change) line.
      const ny = valueToY(lane.param, p.neutral, top);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(140,160,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(70, ny);
      ctx.lineTo(w, ny);
      ctx.stroke();
      ctx.setLineDash([]);
      const color = LANE_COLORS[lane.param];
      if (lane.points.length) {
        ctx.strokeStyle = lane.enabled ? color : 'rgba(140,140,160,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 70; x <= w; x += 2) {
          const y = valueToY(lane.param, laneValue(lane, xToTime(x)), top);
          if (x === 70) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
        for (const pt of lane.points) {
          const x = timeToX(pt.time);
          if (x < 66 || x > w + 6) continue;
          const sel = store.sel.timeline?.kind === 'point' && store.sel.timeline.id === pt.id;
          ctx.fillStyle = sel ? '#ffffff' : color;
          ctx.beginPath();
          if (pt.curve === 'hold') ctx.rect(x - 4, valueToY(lane.param, pt.value, top) - 4, 8, 8);
          else ctx.arc(x, valueToY(lane.param, pt.value, top), sel ? 5.5 : 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = 'rgba(11,13,20,0.9)';
      ctx.fillRect(0, top, 70, LANE_H);
      ctx.fillStyle = lane.enabled ? color : '#7f8bb3';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(p.label.toUpperCase(), 6, top + 18);
      ctx.fillStyle = '#7f8bb3';
      ctx.fillText(lane.target === 'all' ? 'all lasers' : lane.target, 6, top + 31);
      const now = studio.songTime ?? 0;
      ctx.fillText(formatAutoValue(lane.param, lane.points.length ? laneValue(lane, now) : p.neutral), 6, top + 44);
    });

    // Lane labels.
    ctx.fillStyle = 'rgba(11,13,20,0.8)';
    ctx.fillRect(0, RULER + WAVE, 44, CUE_LANE + HIT_LANE);
    ctx.fillStyle = '#7f8bb3';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('CUES', 6, RULER + WAVE + CUE_LANE / 2 + 3);
    ctx.fillText('HITS', 6, RULER + WAVE + CUE_LANE + HIT_LANE / 2 + 3);

    // Playhead.
    const px = Math.round(timeToX(now)) + 0.5;
    ctx.strokeStyle = studio.recordArm ? '#ff3355' : '#ff9f1c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, HEIGHT);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  draw();
}

export function mountCuePalette(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  const render = () => {
    clear(
      root,
      h('div', { class: 'panel-head' }, h('h2', null, 'Cue palette')),
      h('p', { class: 'hint' }, 'Drag a cue onto the timeline, or select one and double-click the cue lane. While playing, click a cue to fire it live.'),
      h(
        'div',
        { class: 'palette' },
        ...store.show.cues.map((cue) =>
          h(
            'button',
            {
              class: `palette-cue ${store.sel.cueId === cue.id ? 'selected' : ''} ${studio.frame.activeCueId === cue.id ? 'live' : ''}`,
              style: `--tag:${cue.tag}`,
              draggable: 'true',
              ondragstart: (e: DragEvent) => e.dataTransfer?.setData('application/x-cue', cue.id),
              onclick: () => {
                store.setSel({ cueId: cue.id });
                if (studio.audio.playing) studio.goCueById(cue.id);
              },
            },
            cue.name,
          ),
        ),
      ),
    );
  };
  render();
  store.subscribe((c) => (c.topics.has('show') || c.topics.has('sel')) && c.source !== 'timeline' && render());
}

export function mountMusicPanel(root: HTMLElement, studio: Studio) {
  const { store } = studio;
  let barsPerCue = 8;
  let accents = true;
  const render = () => {
    const m = store.show.music;
    const sel = store.sel.timeline;
    const hit = sel?.kind === 'hit' ? store.show.timeline.hits.find((x) => x.id === sel.id) : undefined;
    const tc = sel?.kind === 'cue' ? store.show.timeline.cues.find((x) => x.id === sel.id) : undefined;
    clear(
      root,
      h('div', { class: 'panel-head' }, h('h2', null, 'Music sync')),
      !m
        ? h('div', { class: 'empty' }, h('p', null, 'No music loaded.'), button('Load music…', () => studio.loadMusic(), { class: 'btn btn-primary' }))
        : section(
            m.name,
            h('p', { class: 'hint' }, `${fmtTime(m.duration)} · beat grid starts at ${m.offset.toFixed(3)}s`),
            numberInput({ label: 'BPM', value: m.bpm, step: 0.01, min: 40, max: 250, onChange: (v) => store.edit((s) => (s.music!.bpm = v)) }),
            h(
              'div',
              { class: 'row' },
              button('×2', () => store.edit((s) => (s.music!.bpm *= 2)), { class: 'btn btn-sm', title: 'Double tempo' }),
              button('÷2', () => store.edit((s) => (s.music!.bpm /= 2)), { class: 'btn btn-sm', title: 'Halve tempo' }),
              button('Downbeat here', () => setDownbeat(), { class: 'btn btn-sm', title: 'Move the grid so a bar starts at the playhead' }),
            ),
            numberInput({ label: 'Grid offset (s)', value: Number(m.offset.toFixed(3)), step: 0.005, onChange: (v) => store.edit((s) => (s.music!.offset = v)) }),
            select({ label: 'Beats per bar', value: String(m.beatsPerBar), options: ['3', '4', '6', '7'], onChange: (v) => store.edit((s) => (s.music!.beatsPerBar = Number(v))) }),
            toggle({
              label: 'Timeline controls the cues',
              value: store.live.timelineControl,
              onChange: (v) => store.setLive({ timelineControl: v }),
              title: 'Off = cues from the cue list / pads override the timeline while playing',
            }),
            toggle({ label: 'Record live cue presses', value: studio.recordArm, onChange: (v) => ((studio.recordArm = v), store.emit('transport')), title: 'While playing, GO and cue clicks are written to the timeline' }),
          ),
      m
        ? section(
            'Song → show',
            h('p', { class: 'hint' }, 'Designs brand-new cues, colours, hits and build-ups from the song itself. Same song = same show; Remix for a new take. Cues you edit are kept.'),
            select({ label: 'Vibe', value: studio.songShow.vibe, options: VIBES, onChange: (v) => (studio.songShow.vibe = v) }),
            select({
              label: 'New look every',
              value: String(studio.songShow.barsPerVariation),
              options: [{ value: '4', label: '4 bars' }, { value: '8', label: '8 bars' }, { value: '16', label: '16 bars' }],
              onChange: (v) => (studio.songShow.barsPerVariation = Number(v)),
            }),
            h(
              'div',
              { class: 'row' },
              button('Create show from song', () => studio.generateSongShow({ variation: 0 }), { class: 'btn btn-primary' }),
              button('Remix ↻', () => studio.remixSongShow(), { class: 'btn', title: 'A different show for the same song' }),
            ),
          )
        : null,
      m
        ? section(
            'Arrange my cues',
            h('p', { class: 'hint' }, 'Lays your cues along the song: calm cues on quiet parts, intense cues on loud parts, flashes on drops. Replaces the current timeline.'),
            slider({ label: 'Bars per cue', value: barsPerCue, min: 1, max: 32, onInput: (v) => (barsPerCue = v) }),
            toggle({ label: 'Flash on drops', value: accents, onChange: (v) => (accents = v) }),
            button('Auto-program show', () => studio.autoProgram(barsPerCue, accents), { class: 'btn btn-primary' }),
          )
        : null,
      tc
        ? section(
            'Selected cue entry',
            select({ label: 'Cue', value: tc.cueId, options: store.show.cues.map((c) => ({ value: c.id, label: c.name })), onChange: (v) => store.edit((s) => (s.timeline.cues.find((x) => x.id === tc.id)!.cueId = v)) }),
            numberInput({ label: 'Time (s)', value: Number(tc.time.toFixed(3)), step: 0.01, onChange: (v) => store.edit((s) => (s.timeline.cues.find((x) => x.id === tc.id)!.time = Math.max(0, v))) }),
          )
        : null,
      hit
        ? section(
            'Selected hit',
            select({ label: 'Kind', value: hit.kind, options: ['flash', 'strobe', 'blackout'] as const, onChange: (v) => store.edit((s) => (s.timeline.hits.find((x) => x.id === hit.id)!.kind = v)) }),
            numberInput({ label: 'Time (s)', value: Number(hit.time.toFixed(3)), step: 0.01, onChange: (v) => store.edit((s) => (s.timeline.hits.find((x) => x.id === hit.id)!.time = Math.max(0, v))) }),
            numberInput({ label: 'Length (s)', value: hit.duration, step: 0.05, min: 0.05, onChange: (v) => store.edit((s) => (s.timeline.hits.find((x) => x.id === hit.id)!.duration = Math.max(0.05, v))) }),
          )
        : null,
      m ? automationSection() : null,
      pointEditor(),
      section(
        'Live audio',
        h('p', { class: 'hint' }, 'React to a microphone or line input — for busking along with a DJ when no song is loaded. Effects need "Audio react" turned up.'),
        toggle({
          label: 'Microphone / line in',
          value: studio.audio.micOn,
          onChange: async (v) => {
            try {
              if (v) await studio.audio.enableMic();
              else studio.audio.disableMic();
            } catch (e) {
              toast(`Microphone unavailable: ${e instanceof Error ? e.message : e}`, 'error');
            }
            render();
          },
        }),
      ),
    );
  };
  function automationSection() {
    const groups = [...new Set(store.show.fixtures.map((f) => f.group))];
    const targets = [{ value: 'all', label: 'All lasers' }, ...groups.map((g) => ({ value: g, label: g }))];
    let param: AutoParam = 'intensity';
    let target = 'all';
    const addLane = async () => {
      const ok = await modal(
        'Add automation lane',
        h(
          'div',
          { class: 'form' },
          h('p', { class: 'hint' }, 'A curve that changes every running look over the song — e.g. intensity rising into a drop. Click in the lane to add points, drag to move them, double-click to delete.'),
          select({ label: 'Parameter', value: param, options: AUTO_PARAM_IDS.map((id) => ({ value: id, label: AUTO_PARAMS[id].label })), onChange: (v) => (param = v) }),
          select({ label: 'Lasers', value: target, options: targets, onChange: (v) => (target = v) }),
        ),
        [
          { label: 'Cancel', value: false },
          { label: 'Add lane', value: true, primary: true },
        ],
      );
      if (!ok) return;
      store.edit((s) => s.timeline.lanes.push({ id: uid('lane'), param, target, enabled: true, points: [] }));
    };
    const buildUp = () => {
      // Handy preset: intensity + speed ramp over the 8 bars before the playhead, then full on.
      const mu = store.show.music!;
      const t1 = studio.songTime ?? 0;
      const t0 = Math.max(0, t1 - (60 / mu.bpm) * mu.beatsPerBar * 8);
      store.edit((s) => {
        const pts = (a: number, b: number) => [
          { id: uid('pt'), time: t0, value: a, curve: 'smooth' as const },
          { id: uid('pt'), time: t1, value: b, curve: 'linear' as const },
        ];
        s.timeline.lanes.push({ id: uid('lane'), param: 'intensity', target: 'all', enabled: true, points: pts(0.25, 1) });
        s.timeline.lanes.push({ id: uid('lane'), param: 'speed', target: 'all', enabled: true, points: pts(0.5, 2) });
      });
    };
    return section(
      'Automation',
      h('p', { class: 'hint' }, 'Curves on the timeline that shape every look: builds, fades, speed-ups, colour drifts.'),
      h(
        'div',
        { class: 'row' },
        button('＋ Lane', addLane, { class: 'btn btn-sm' }),
        button('8-bar build-up to playhead', buildUp, { class: 'btn btn-sm', title: 'Adds an intensity and speed ramp ending at the playhead (put the playhead on the drop)' }),
      ),
      ...store.show.timeline.lanes.map((lane, i) =>
        h(
          'div',
          { class: 'lane-row' },
          h('span', { class: 'lane-name' }, AUTO_PARAMS[lane.param].label),
          select({ value: lane.target, options: targets.some((t) => t.value === lane.target) ? targets : [...targets, { value: lane.target, label: lane.target }], onChange: (v) => store.edit((s) => (s.timeline.lanes[i].target = v)) }),
          h('input', { type: 'checkbox', checked: lane.enabled, title: 'Enabled', onchange: (e: Event) => store.edit((s) => (s.timeline.lanes[i].enabled = (e.target as HTMLInputElement).checked)) }),
          button('✕', () => store.edit((s) => s.timeline.lanes.splice(i, 1)), { class: 'btn btn-xs', title: 'Delete lane' }),
        ),
      ),
    );
  }

  function pointEditor() {
    const sel = store.sel.timeline;
    if (sel?.kind !== 'point') return null;
    const lane = store.show.timeline.lanes.find((l) => l.id === sel.laneId);
    const pt = lane?.points.find((p) => p.id === sel.id);
    if (!lane || !pt) return null;
    const p = AUTO_PARAMS[lane.param];
    const upd = (fn: (x: AutoPoint) => void) =>
      store.edit((s) => {
        const l = s.timeline.lanes.find((x) => x.id === lane.id)!;
        fn(l.points.find((x) => x.id === pt.id)!);
        l.points.sort((a, b) => a.time - b.time);
      });
    return section(
      `${p.label} point`,
      numberInput({ label: 'Time (s)', value: Number(pt.time.toFixed(3)), step: 0.01, min: 0, onChange: (v) => upd((x) => (x.time = Math.max(0, v))) }),
      numberInput({ label: `Value (${p.min}–${p.max})`, value: pt.value, step: (p.max - p.min) / 100, min: p.min, max: p.max, onChange: (v) => upd((x) => (x.value = clamp(v, p.min, p.max))) }),
      select({ label: 'Curve to next', value: pt.curve, options: [{ value: 'linear', label: 'Linear' }, { value: 'smooth', label: 'Smooth (ease)' }, { value: 'hold', label: 'Hold (step)' }], onChange: (v) => upd((x) => (x.curve = v)) }),
    );
  }

  function setDownbeat() {
    const t = studio.songTime;
    const m = store.show.music;
    if (t === null || !m) return;
    const bar = (60 / m.bpm) * m.beatsPerBar;
    store.edit((s) => (s.music!.offset = ((t % bar) + bar) % bar));
  }
  render();
  store.subscribe((c) => {
    if (c.source === 'timeline' && !c.topics.has('sel')) return;
    if (c.topics.has('show') || c.topics.has('sel') || c.topics.has('transport') || c.topics.has('live')) render();
  });
}
