// One API for everything that touches the operating system. In the desktop app
// it calls the Rust backend; in a plain browser (`npm run dev`) it falls back
// to file pickers/downloads and turns hardware features into no-ops.

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface PickedFile {
  name: string;
  path?: string;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

async function dialog() {
  return import('@tauri-apps/plugin-dialog');
}

/** Browser fallback: show a file picker and resolve with the chosen File. */
function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openTextFile(label: string, exts: string[]): Promise<(PickedFile & { text: string }) | null> {
  if (isDesktop) {
    const path = await (await dialog()).open({ filters: [{ name: label, extensions: exts }], multiple: false });
    if (typeof path !== 'string') return null;
    return { name: baseName(path), path, text: await invoke<string>('read_text_file', { path }) };
  }
  const f = await pickBrowserFile(exts.map((e) => '.' + e).join(','));
  return f ? { name: f.name, text: await f.text() } : null;
}

/** Save text. With a known path (and not "save as") writes straight there. Returns the path/name saved to. */
export async function saveTextFile(text: string, opts: { path?: string; suggested: string; label: string; ext: string; saveAs?: boolean }): Promise<string | null> {
  if (isDesktop) {
    let path = opts.saveAs ? undefined : opts.path;
    if (!path) {
      const picked = await (await dialog()).save({ defaultPath: opts.suggested, filters: [{ name: opts.label, extensions: [opts.ext] }] });
      if (!picked) return null;
      path = picked;
    }
    await invoke('write_text_file', { path, contents: text });
    return path;
  }
  download(opts.suggested, text, 'application/json');
  return opts.suggested;
}

export async function openBinaryFile(label: string, exts: string[]): Promise<(PickedFile & { data: ArrayBuffer }) | null> {
  if (isDesktop) {
    const path = await (await dialog()).open({ filters: [{ name: label, extensions: exts }], multiple: false });
    if (typeof path !== 'string') return null;
    return { name: baseName(path), path, data: await readBinary(path) };
  }
  const f = await pickBrowserFile(exts.map((e) => '.' + e).join(','));
  return f ? { name: f.name, data: await f.arrayBuffer() } : null;
}

/** Show file the app was launched with (desktop only). */
export async function startupFile(): Promise<(PickedFile & { text: string }) | null> {
  if (!isDesktop) return null;
  const path = await invoke<string | null>('startup_file');
  if (!path) return null;
  return { name: baseName(path), path, text: await invoke<string>('read_text_file', { path }) };
}

export async function readBinary(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_binary_file', { path });
}

export async function saveBinaryFile(data: ArrayBuffer | Blob, opts: { suggested: string; label: string; ext: string }): Promise<string | null> {
  if (isDesktop) {
    const path = await (await dialog()).save({ defaultPath: opts.suggested, filters: [{ name: opts.label, extensions: [opts.ext] }] });
    if (!path) return null;
    const buf = data instanceof Blob ? await data.arrayBuffer() : data;
    // Raw body: avoids turning a large video into a JSON number array.
    await invoke('write_binary_file', new Uint8Array(buf), { headers: { path: encodeURIComponent(path) } });
    return path;
  }
  download(opts.suggested, data, 'application/octet-stream');
  return opts.suggested;
}

// ---------------------------------------------------------------- hardware

export const hardware = {
  async artnetSend(host: string, universe: number, data: Uint8Array): Promise<void> {
    if (!isDesktop) return;
    await invoke('artnet_send', { host, universe, data: Array.from(data) });
  },
  async oscStart(port: number): Promise<void> {
    if (isDesktop) await invoke('osc_start', { port });
  },
  async oscStop(): Promise<void> {
    if (isDesktop) await invoke('osc_stop');
  },
  async midiPorts(): Promise<string[]> {
    return isDesktop ? invoke<string[]>('midi_ports') : [];
  },
  async midiOpen(name: string): Promise<void> {
    if (isDesktop) await invoke('midi_open', { name });
  },
  async midiClose(): Promise<void> {
    if (isDesktop) await invoke('midi_close');
  },
  async etherdreamScan(): Promise<DacInfo[]> {
    return isDesktop ? invoke<DacInfo[]>('etherdream_scan') : [];
  },
  /** Stream one frame of points to a DAC. Points are [x, y, r, g, b] with x/y in -1..1, colours 0..1. */
  async etherdreamFrame(ip: string, points: number[], pps: number): Promise<void> {
    if (isDesktop) await invoke('etherdream_frame', { ip, points, pps });
  },
  async etherdreamStop(): Promise<void> {
    if (isDesktop) await invoke('etherdream_stop');
  },
};

export interface DacInfo {
  ip: string;
  mac: string;
  hwRevision: number;
  swRevision: number;
}

export interface OscMessage {
  address: string;
  args: (number | string)[];
}

export type MidiMessage =
  | { kind: 'note'; channel: number; note: number; velocity: number }
  | { kind: 'cc'; channel: number; controller: number; value: number }
  | { kind: 'timecode'; seconds: number };

/** Subscribe to events from the backend. Returns an unsubscribe function. */
export function onBackend<T>(event: 'osc' | 'midi' | 'backend-error', cb: (payload: T) => void): () => void {
  if (!isDesktop) return () => {};
  let un: UnlistenFn | null = null;
  let cancelled = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => (cancelled ? u() : (un = u)));
  return () => {
    cancelled = true;
    un?.();
  };
}

// ---------------------------------------------------------------- output window

const CHANNEL = 'laser-studio-sync';
let bc: BroadcastChannel | null = null;
const channel = () => (bc ??= new BroadcastChannel(CHANNEL));

/** Send a sync message to the output window(s). */
export function broadcast(msg: unknown) {
  if (isDesktop) void emit(CHANNEL, msg);
  else channel().postMessage(msg);
}

export function onBroadcast(cb: (msg: unknown) => void): () => void {
  if (isDesktop) {
    let un: UnlistenFn | null = null;
    listen(CHANNEL, (e) => cb(e.payload)).then((u) => (un = u));
    return () => un?.();
  }
  const handler = (e: MessageEvent) => cb(e.data);
  channel().addEventListener('message', handler);
  return () => channel().removeEventListener('message', handler);
}

export async function openOutputWindow(): Promise<void> {
  const url = `${location.pathname}?view=output`;
  if (isDesktop) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel('output');
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow('output', { url, title: 'Laser Studio — Output', width: 1280, height: 720, dragDropEnabled: false });
    return;
  }
  window.open(url, 'laser-output', 'width=1280,height=720');
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  }
}
