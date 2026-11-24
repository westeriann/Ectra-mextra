// Tiny DOM helpers — the UI is plain TypeScript, no framework.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

// ------------------------------------------------------------------ controls

export function slider(opts: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  title?: string;
}): HTMLElement {
  const fmt = opts.format ?? ((v: number) => `${round(v, opts.step ?? 1)}${opts.unit ?? ''}`);
  const out = h('output', null, fmt(opts.value));
  const input = h('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step ?? 1),
    value: String(opts.value),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = fmt(v);
      opts.onInput(v);
    },
    ondblclick: () => {
      // Double-click to type an exact value.
      const typed = prompt(`${opts.label} (${opts.min}–${opts.max})`, String(input.value));
      if (typed === null || typed.trim() === '' || Number.isNaN(Number(typed))) return;
      const v = Math.min(opts.max, Math.max(opts.min, Number(typed)));
      input.value = String(v);
      out.textContent = fmt(v);
      opts.onInput(v);
    },
  });
  return h('label', { class: 'ctl ctl-slider', title: opts.title ?? 'Double-click to type a value' }, h('span', { class: 'ctl-label' }, opts.label), input, out);
}

function round(v: number, step: number) {
  const d = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
  return v.toFixed(d);
}

export function select<T extends string>(opts: { label?: string; value: T; options: { value: T; label: string }[] | readonly T[]; onChange: (v: T) => void }): HTMLElement {
  const sel = h(
    'select',
    { onchange: (e: Event) => opts.onChange((e.target as HTMLSelectElement).value as T) },
    ...(opts.options as (T | { value: T; label: string })[]).map((o) => {
      const value = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : o.label;
      return h('option', { value, selected: value === opts.value }, label);
    }),
  );
  sel.value = opts.value;
  return opts.label ? h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, opts.label), sel) : sel;
}

export function toggle(opts: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }): HTMLElement {
  return h(
    'label',
    { class: 'ctl ctl-toggle', title: opts.title },
    h('input', { type: 'checkbox', checked: opts.value, onchange: (e: Event) => opts.onChange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'switch' }),
    h('span', { class: 'ctl-label' }, opts.label),
  );
}

export function colorInput(opts: { label: string; value: string; onInput: (v: string) => void }): HTMLElement {
  return h(
    'label',
    { class: 'ctl ctl-color' },
    h('span', { class: 'ctl-label' }, opts.label),
    h('input', { type: 'color', value: opts.value, oninput: (e: Event) => opts.onInput((e.target as HTMLInputElement).value) }),
  );
}

export function textInput(opts: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }): HTMLElement {
  return h(
    'label',
    { class: 'ctl' },
    h('span', { class: 'ctl-label' }, opts.label),
    h('input', { type: 'text', value: opts.value, placeholder: opts.placeholder ?? '', onchange: (e: Event) => opts.onChange((e.target as HTMLInputElement).value) }),
  );
}

export function numberInput(opts: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }): HTMLElement {
  return h(
    'label',
    { class: 'ctl ctl-number' },
    h('span', { class: 'ctl-label' }, opts.label),
    h('input', {
      type: 'number',
      value: String(opts.value),
      step: String(opts.step ?? 0.1),
      min: opts.min !== undefined ? String(opts.min) : undefined,
      max: opts.max !== undefined ? String(opts.max) : undefined,
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (!Number.isNaN(v)) opts.onChange(v);
      },
    }),
  );
}

/** Three number inputs for an x/y/z vector. */
export function vec3Input(label: string, value: [number, number, number], onChange: (v: [number, number, number]) => void, step = 0.1): HTMLElement {
  const inputs = value.map((v, i) =>
    h('input', {
      type: 'number',
      step: String(step),
      value: String(v),
      title: 'xyz'[i],
      onchange: () => onChange(inputs.map((n) => Number(n.value) || 0) as [number, number, number]),
    }),
  );
  return h('label', { class: 'ctl ctl-vec' }, h('span', { class: 'ctl-label' }, label), h('div', { class: 'vec' }, ...inputs));
}

export function button(label: string | Node, onClick: (e: MouseEvent) => void, opts: { class?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', { class: opts.class ?? 'btn', title: opts.title, disabled: opts.disabled, onclick: onClick }, label);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', null, title), ...children);
}

let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: 'info' | 'error' = 'info') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 2600);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3100);
}

/** Simple modal; resolves with the clicked button's value. */
export function modal<T>(title: string, body: Child, buttons: { label: string; value: T; primary?: boolean }[]): Promise<T | null> {
  return new Promise((resolve) => {
    const close = (v: T | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overlay = h(
      'div',
      { class: 'modal-overlay', onclick: (e: MouseEvent) => e.target === overlay && close(null) },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-label': title },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-actions' }, ...buttons.map((b) => button(b.label, () => close(b.value), { class: b.primary ? 'btn btn-primary' : 'btn' }))),
      ),
    );
    document.body.appendChild(overlay);
  });
}
