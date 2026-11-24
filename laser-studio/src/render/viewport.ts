import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Frame } from '../core/engine';
import { buildTraceScene } from '../core/trace';
import type { Show, Vec3 } from '../core/types';
import { BeamLayer } from './beams';
import { StageBuilder, type Pickable } from './stage';

export type CameraPreset = 'foh' | 'crowd' | 'side' | 'top' | 'drone';
export const CAMERA_PRESETS: { id: CameraPreset; label: string; key: string }[] = [
  { id: 'foh', label: 'Front of house', key: 'F1' },
  { id: 'crowd', label: 'In the crowd', key: 'F2' },
  { id: 'side', label: 'Side', key: 'F3' },
  { id: 'top', label: 'Top down', key: 'F4' },
  { id: 'drone', label: 'Drone orbit', key: 'F5' },
];

export type Quality = 'high' | 'medium' | 'low';

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  readonly controls: OrbitControls;
  private gizmo: TransformControls | null = null;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private beams = new BeamLayer();
  private stage = new StageBuilder();
  private stageKey = '';
  private resizeObs: ResizeObserver;
  private drone = false;
  private quality: Quality = 'high';
  private bounds = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 10, 20));
  /** Called when the user clicks something in the scene (null = empty space). */
  onPick: ((p: Pickable | null, additive: boolean) => void) | null = null;
  /** Called while the gizmo drags an object. */
  onMove: ((p: Pickable, position: Vec3) => void) | null = null;
  /** Called once a gizmo drag ends (for undo history). */
  onMoveEnd: (() => void) | null = null;
  private gizmoTarget: Pickable | null = null;
  private recorder: MediaRecorder | null = null;

  constructor(readonly container: HTMLElement, opts: { interactive: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewport-canvas');

    this.scene.add(this.stage.group, this.beams.group);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('start', () => (this.drone = false));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.3, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    if (opts.interactive) this.setupPicking();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
  }

  private setupPicking() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      if (this.gizmo?.dragging) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects([this.stage.fixtureGroup, this.stage.group], true);
      // Fixtures win over the elements they sit on; the floor loses to everything.
      const picks = hits.map((h) => h.object.userData.pick as Pickable | undefined).filter((p): p is Pickable => !!p);
      const fixture = picks.find((p) => p.kind === 'fixture');
      this.onPick?.(fixture ?? picks[0] ?? null, e.shiftKey || e.metaKey || e.ctrlKey);
    });
  }

  /** Show a move gizmo on one object (stage design mode), or hide it. */
  setGizmo(target: Pickable | null) {
    this.gizmoTarget = target;
    const obj = target ? this.stage.meshes.get(target.id) : undefined;
    if (!obj) {
      if (this.gizmo) this.gizmo.detach();
      return;
    }
    if (!this.gizmo) {
      this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
      this.gizmo.setSize(0.8);
      this.gizmo.addEventListener('dragging-changed', (e) => {
        this.controls.enabled = !e.value;
        if (!e.value) this.onMoveEnd?.();
      });
      this.gizmo.addEventListener('objectChange', () => {
        const o = this.gizmo?.object;
        if (o && this.gizmoTarget) this.onMove?.(this.gizmoTarget, [round(o.position.x), round(o.position.y), round(o.position.z)]);
      });
      this.scene.add(this.gizmo.getHelper());
    }
    if (this.gizmo.object !== obj) this.gizmo.attach(obj);
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.bloom.enabled = q !== 'low';
    this.renderer.setPixelRatio(q === 'high' ? Math.min(devicePixelRatio, 2) : 1);
    this.resize();
  }

  /** Rebuild stage geometry only when the stage or fixtures changed. */
  syncShow(show: Show, force = false) {
    const key = JSON.stringify([show.stage, show.fixtures]);
    // The gizmo moves the mesh itself while dragging; rebuild once it lets go.
    if (this.gizmo?.dragging && !force) return;
    if (key !== this.stageKey || force) {
      this.stageKey = key;
      const keep = this.gizmoTarget;
      this.stage.build(show.stage, show.fixtures);
      this.beams.scene = buildTraceScene(show.stage);
      this.scene.background = new THREE.Color(show.stage.sky);
      this.scene.fog = new THREE.FogExp2(show.stage.sky, 0.002 + show.stage.haze * 0.006);
      this.computeBounds(show);
      if (keep) this.setGizmo(keep);
    }
    this.beams.setHaze(show.stage.haze);
  }

  setSelection(ids: Set<string>) {
    this.stage.setSelection(ids);
  }

  /** Bright, even light so the venue is visible while designing it. */
  setWorkLights(on: boolean) {
    this.stage.workLights = on;
  }

  private computeBounds(show: Show) {
    const b = new THREE.Box3();
    for (const el of show.stage.elements) {
      if (el.kind === 'floor') continue;
      const [x, y, z] = el.position;
      const r = Math.max(el.size[0], el.size[2]) / 2;
      b.expandByPoint(new THREE.Vector3(x - r, y, z - r));
      b.expandByPoint(new THREE.Vector3(x + r, y + el.size[1], z + r));
    }
    for (const f of show.fixtures) b.expandByPoint(new THREE.Vector3(...f.position));
    if (!b.isEmpty()) this.bounds = b;
  }

  setCamera(preset: CameraPreset) {
    const c = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 12);
    this.drone = preset === 'drone';
    const stageZ = this.bounds.min.z + Math.min(size.z, 20) * 0.3;
    switch (preset) {
      case 'foh':
        this.camera.position.set(c.x, 5, c.z + size.z * 0.42);
        this.controls.target.set(c.x, size.y * 0.45, stageZ);
        break;
      case 'crowd':
        this.camera.position.set(c.x + 2, 1.7, c.z + size.z * 0.15);
        this.controls.target.set(c.x, size.y * 0.6, stageZ);
        break;
      case 'side':
        this.camera.position.set(this.bounds.max.x + span * 0.6, 8, c.z);
        this.controls.target.set(c.x, size.y * 0.35, c.z);
        break;
      case 'top':
        this.camera.position.set(c.x, span * 1.3, c.z + 0.01);
        this.controls.target.copy(c);
        break;
      case 'drone':
        this.camera.position.set(c.x + span * 0.7, span * 0.45, c.z + span * 0.7);
        this.controls.target.set(c.x, size.y * 0.3, c.z);
        break;
    }
    this.controls.update();
  }

  render(show: Show, frame: Frame, time: number, dt: number) {
    this.beams.update(show.fixtures, frame.fixtures, time);
    const colors = new Map<string, THREE.Color>();
    for (const fr of frame.fixtures) {
      if (!fr.beams.length) continue;
      const col = new THREE.Color(0, 0, 0);
      for (const b of fr.beams) col.add(new THREE.Color(b.r * b.a, b.g * b.a, b.b * b.a));
      col.multiplyScalar(Math.min(1, fr.beams.length / 8) / fr.beams.length);
      colors.set(fr.fixtureId, col);
    }
    this.stage.animate(time, frame.beat, frame.flash, frame.level, colors);
    if (this.drone) {
      const t = this.controls.target;
      const p = this.camera.position.clone().sub(t);
      p.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.12);
      this.camera.position.copy(t).add(p);
    }
    this.controls.update();
    if (this.quality === 'low') this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }

  get beamCount() {
    return this.beams.beamCount;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Start recording the viewport to a WebM video. */
  startRecording(audio?: MediaStream): boolean {
    if (this.recorder || typeof MediaRecorder === 'undefined') return false;
    const stream = this.renderer.domElement.captureStream(60);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return false;
    this.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16_000_000 });
    const chunks: Blob[] = [];
    this.recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this.recorder.onstop = () => this.onRecorded?.(new Blob(chunks, { type }), type.includes('mp4') ? 'mp4' : 'webm');
    this.recorder.start(500);
    return true;
  }

  stopRecording() {
    this.recorder?.stop();
    this.recorder = null;
  }

  get recording() {
    return !!this.recorder;
  }

  onRecorded: ((blob: Blob, ext: string) => void) | null = null;
}

const round = (v: number) => Math.round(v * 100) / 100;
