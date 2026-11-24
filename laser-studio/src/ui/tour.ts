// First-run guided tour: highlights one part of the UI at a time with a short
// explanation. Shown once automatically; reopen it from File → Tutorial.

import { button, h } from './dom';
import type { Mode } from './store';
import type { Studio } from './studio';

const DONE_KEY = 'laser-studio:tour-done';

interface Step {
  title: string;
  body: string;
  /** CSS selector of the element to highlight (centered card if missing). */
  target?: string;
  mode?: Mode;
  /** Prepare the UI for this step (select things, fire a cue...). */
  before?: (s: Studio) => void;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Laser Studio',
    body: 'Design a venue, program laser looks and sync a whole show to music. This 1-minute tour shows you the basics. You can reopen it any time from File → Tutorial.',
  },
  {
    title: 'Four workspaces',
    body: 'Program builds looks and cues. Show syncs them to a song. Stage is where you design the venue and hang lasers. Setup connects real hardware.',
    target: '.tabs',
  },
  {
    title: 'Fire a cue',
    body: 'Each card is a saved look. Click one to put it on stage, or press GO (Enter) to step through them in order.',
    target: '.cue-list',
    mode: 'program',
    before: (s) => s.goCueByNumber(1),
  },
  {
    title: 'Pick lasers',
    body: 'Select lasers here, or click them in the 3D view. Click a group name to select the whole group; Shift-click to add more.',
    target: '.slot[data-mode="program"] .fx-group',
    mode: 'program',
    before: (s) => s.store.setSel({ fixtures: s.store.show.fixtures.map((f) => f.id) }),
  },
  {
    title: 'Shape the look',
    body: 'Choose an effect and tweak beams, movement, colour and strobe. Changes show live. Speeds lock to the beat so everything stays in time with the music.',
    target: '.slot[data-mode="program"] .kind-grid',
    mode: 'program',
  },
  {
    title: 'Save it as a cue',
    body: 'Happy with it? Record it as a new cue (R). To change an existing cue, press Edit on its card, adjust, then Update.',
    target: '.prog-actions',
    mode: 'program',
  },
  {
    title: 'Flash pads',
    body: 'Hold a pad (or keys 1–8) to slam a look on top of the show — perfect for drops. Right-click a pad to choose its cue.',
    target: '.pads',
    mode: 'program',
  },
  {
    title: 'Sync to music',
    body: 'In Show, load a song: tempo and beats are detected for you. Drag cues onto the timeline, add automation curves for builds, or press Auto-program to lay out a whole show.',
    target: '.slot[data-mode="show"]',
    mode: 'show',
  },
  {
    title: 'Design your stage',
    body: 'Start from a template or build from scratch: add risers, truss, screens, mirrors and mirror balls, then drag them around in 3D or on the floor plan.',
    target: '.slot[data-mode="stage"] .add-grid',
    mode: 'stage',
  },
  {
    title: 'Put it on a big screen',
    body: 'Open a fullscreen output window for a projector, switch cameras with F1–F5, and record your show to video with REC. Press ? any time for keyboard shortcuts. Have fun!',
    target: '.tb-right',
    mode: 'program',
  },
];

export function tourDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function startTour(studio: Studio) {
  document.querySelector('.tour')?.remove();
  let i = 0;
  const ring = h('div', { class: 'tour-ring' });
  const title = h('h2');
  const body = h('p');
  const counter = h('span', { class: 'tour-count' });
  const back = button('Back', () => show(i - 1), { class: 'btn btn-sm' });
  const next = button('Next', () => (i === STEPS.length - 1 ? finish() : show(i + 1)), { class: 'btn btn-sm btn-primary' });
  const card = h(
    'div',
    { class: 'tour-card', role: 'dialog', 'aria-live': 'polite' },
    title,
    body,
    h('div', { class: 'tour-actions' }, button('Skip tour', finish, { class: 'btn btn-sm' }), h('span', { class: 'grow' }), counter, back, next),
  );
  const root = h('div', { class: 'tour' }, ring, card);
  document.body.appendChild(root);
  let raf = 0;

  function finish() {
    cancelAnimationFrame(raf);
    root.remove();
    window.removeEventListener('keydown', onKey, true);
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* private mode */
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight') show(Math.min(i + 1, STEPS.length - 1));
    else if (e.key === 'ArrowLeft') show(Math.max(i - 1, 0));
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  window.addEventListener('keydown', onKey, true);

  function show(n: number) {
    i = Math.max(0, Math.min(STEPS.length - 1, n));
    const step = STEPS[i];
    if (step.mode) studio.store.setMode(step.mode);
    step.before?.(studio);
    title.textContent = step.title;
    body.textContent = step.body;
    counter.textContent = `${i + 1} / ${STEPS.length}`;
    back.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
  }

  // Follow the target every frame (panels re-render and move around).
  const place = () => {
    raf = requestAnimationFrame(place);
    const sel = STEPS[i].target;
    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    if (!r || r.width === 0) {
      ring.style.display = 'none';
      card.style.left = `${innerWidth / 2 - card.offsetWidth / 2}px`;
      card.style.top = `${innerHeight / 2 - card.offsetHeight / 2}px`;
      root.classList.add('dim');
      return;
    }
    root.classList.remove('dim');
    const pad = 6;
    ring.style.display = '';
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Put the card beside the target: below if there's room, otherwise above, otherwise beside.
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let top = r.bottom + 14;
    if (top + ch > innerHeight - 10) top = r.top - ch - 14;
    let left = r.left + r.width / 2 - cw / 2;
    if (top < 10) {
      top = Math.min(innerHeight - ch - 10, Math.max(10, r.top));
      left = r.right + 14 + cw < innerWidth ? r.right + 14 : r.left - cw - 14;
    }
    card.style.left = `${Math.max(10, Math.min(innerWidth - cw - 10, left))}px`;
    card.style.top = `${Math.max(10, top)}px`;
  };
  show(0);
  place();
}
