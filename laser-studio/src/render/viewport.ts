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
  /** Called while the gizmo moves, rotates or scales an object. */
  onTransform: ((p: Pickable, t: GizmoChange) => void) | null = null;
  /** Called when a gizmo drag starts (to remember the starting size for scaling). */
  onTransformStart: ((p: Pickable) => void) | null = null;
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
    // Allow looking up at rigs and roofs (the fly keys keep the camera above the floor).
    this.controls.maxPolarAngle = Math.PI * 0.97;
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

  /** Stage mode: objects can be grabbed and dragged straight in the 3D view. */
  dragEnabled = false;
  private grab: { target: Pickable; obj: THREE.Object3D; plane: THREE.Plane; offset: THREE.Vector3; vertical: boolean } | null = null;

  private ndc(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pickAt(e: PointerEvent): Pickable | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.ndc(e), this.camera);
    const hits = ray.intersectObjects([this.stage.fixtureGroup, this.stage.group], true);
    const picks = hits.map((h) => h.object.userData.pick as Pickable | undefined).filter((p): p is Pickable => !!p);
    return picks.find((p) => p.kind === 'fixture') ?? picks[0] ?? null;
  }

  private setupPicking() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
      // Grab-and-drag: press on an object (not on a gizmo handle) with the Move tool.
      if (!this.dragEnabled || e.button !== 0 || this.gizmoMode !== 'translate' || this.gizmo?.axis) return;
      const p = this.pickAt(e);
      const obj = p ? this.stage.meshes.get(p.id) : undefined;
      if (!p || !obj || this.isFloor(p.id)) return;
      this.onPick?.(p, false);
      const vertical = e.shiftKey;
      const normal = vertical ? this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize().negate() : new THREE.Vector3(0, 1, 0);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, obj.position);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(this.ndc(e), this.camera);
      const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      this.grab = { target: p, obj, plane, offset: obj.position.clone().sub(hit), vertical };
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      this.onTransformStart?.(p);
    });
    el.addEventListener('pointermove', (e) => {
      const g = this.grab;
      if (!g) return;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(this.ndc(e), this.camera);
      const hit = ray.ray.intersectPlane(g.plane, new THREE.Vector3());
      if (!hit) return;
      const pos = hit.add(g.offset);
      const snap = (v: number) => (this.gizmoSnap && !e.altKey ? Math.round(v * 2) / 2 : round(v));
      if (g.vertical) g.obj.position.y = Math.max(0, snap(pos.y));
      else g.obj.position.set(snap(pos.x), g.obj.position.y, snap(pos.z));
      this.onTransform?.(g.target, { position: [round(g.obj.position.x), round(g.obj.position.y), round(g.obj.position.z)] });
    });
    const endGrab = () => {
      if (!this.grab) return;
      this.grab = null;
      this.controls.enabled = true;
      this.onMoveEnd?.();
    };
    el.addEventListener('pointerup', endGrab);
    el.addEventListener('pointercancel', endGrab);
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
  /** Show the move/rotate/scale gizmo on one object (stage design mode), or hide it. */
  setGizmo(target: Pickable | null, elementKind?: string) {
    this.gizmoTarget = target;
    this.gizmoKind = elementKind;
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
        if (e.value && this.gizmoTarget) this.onTransformStart?.(this.gizmoTarget);
        if (!e.value) this.onMoveEnd?.();
      });
      this.gizmo.addEventListener('objectChange', () => this.emitTransform());
      this.scene.add(this.gizmo.getHelper());
    }
    if (this.gizmo.object !== obj) this.gizmo.attach(obj);
    this.applyGizmoMode();
  }

  private gizmoKind: string | undefined;
  gizmoMode: GizmoMode = 'translate';
  gizmoSnap = true;

  setGizmoMode(mode: GizmoMode) {
    this.gizmoMode = mode;
    this.applyGizmoMode();
  }

  setGizmoSnap(on: boolean) {
    this.gizmoSnap = on;
    this.applyGizmoMode();
  }

  /** Which handles make sense depends on what is selected. */
  private applyGizmoMode() {
    const g = this.gizmo;
    if (!g) return;
    const fixture = this.gizmoTarget?.kind === 'fixture';
    let mode = this.gizmoMode;
    // Lasers have no size: fall back to rotate (aim) when Scale is picked.
    if (fixture && mode === 'scale') mode = 'rotate';
    g.setMode(mode);
    g.setSpace(mode === 'translate' ? 'world' : 'local');
    g.showX = g.showY = g.showZ = true;
    if (mode === 'rotate') {
      // Elements turn around the vertical axis; lasers also tilt (aim up/down).
      g.showX = fixture;
      g.showZ = false;
    }
    g.setTranslationSnap(this.gizmoSnap ? 0.5 : null);
    g.setRotationSnap(this.gizmoSnap ? THREE.MathUtils.degToRad(15) : null);
    g.setScaleSnap(this.gizmoSnap ? 0.1 : null);
  }

  private emitTransform() {
    const o = this.gizmo?.object;
    const t = this.gizmoTarget;
    if (!o || !t) return;
    const mode = this.gizmo!.mode;
    if (mode === 'translate') {
      this.onTransform?.(t, { position: [round(o.position.x), round(o.position.y), round(o.position.z)] });
    } else if (mode === 'rotate') {
      const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ');
      const yaw = wrapDeg(THREE.MathUtils.radToDeg(e.y));
      const pitch = -THREE.MathUtils.radToDeg(e.x);
      this.onTransform?.(t, { rotation: [Math.round(yaw * 10) / 10, Math.round(pitch * 10) / 10] });
    } else {
      let s: Vec3 = [o.scale.x, o.scale.y, o.scale.z];
      if (this.gizmoKind === 'mirrorball') {
        // Keep balls round: use whichever axis moved most.
        const k = s.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
        s = [k, k, k];
        o.scale.setScalar(k);
      }
      this.onTransform?.(t, { scale: s.map((v) => Math.max(0.02, v)) as Vec3 });
    }
  }

  /** Where a screen point lands on the floor (for dropping new items into 3D). */
  floorPointAt(clientX: number, clientY: number): [number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.stage.floorY), new THREE.Vector3());
    return hit ? [hit.x, hit.z] : null;
  }

  /** Ids of floor elements (never dragged). */
  floorIds = new Set<string>();
  private isFloor(id: string) {
    return this.floorIds.has(id);
  }

  // ------------------------------------------------------------ fly camera
  /** Keys currently held for camera movement (w a s d q e z x, plus shift). */
  readonly flyKeys = new Set<string>();

  private fly(dt: number) {
    const k = this.flyKeys;
    if (!k.size) return;
    this.drone = false;
    const cam = this.camera.position;
    const target = this.controls.target;
    const size = this.bounds.getSize(new THREE.Vector3());
    const speed = Math.max(6, Math.max(size.x, size.z) * 0.35) * (k.has('shift') ? 3 : 1) * dt;
    const look = target.clone().sub(cam);
    const forward = look.clone().setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    // Move: W/S forward/back, A/D strafe — camera and its look-at point move together.
    const move = new THREE.Vector3();
    if (k.has('w')) move.add(forward);
    if (k.has('s')) move.sub(forward);
    if (k.has('d')) move.add(right);
    if (k.has('a')) move.sub(right);
    if (move.lengthSq()) {
      move.normalize().multiplyScalar(speed);
      cam.add(move);
      target.add(move);
    }
    // Turn: Q/E rotate left/right, Z/X look up/down — around the camera itself.
    const turn = 1.4 * dt * (k.has('shift') ? 1.8 : 1);
    if (k.has('q')) look.applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
    if (k.has('e')) look.applyAxisAngle(new THREE.Vector3(0, 1, 0), -turn);
    if (k.has('z') || k.has('x')) {
      const pitchAxis = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0)).normalize();
      const tilted = look.clone().applyAxisAngle(pitchAxis, k.has('z') ? turn : -turn); // Z looks up, X looks down
      // Don't flip over the top or bottom.
      const angle = tilted.angleTo(new THREE.Vector3(0, 1, 0));
      if (angle > 0.08 && angle < Math.PI - 0.08) look.copy(tilted);
    }
    // Stay above the floor.
    const minY = this.stage.floorY + 0.3;
    if (cam.y < minY) cam.y = minY;
    target.copy(cam).add(look);
  }

  /** Point the camera at an object. */
  focus(id: string) {
    const obj = this.stage.meshes.get(id);
    if (!obj) return;
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(2, box.getSize(new THREE.Vector3()).length());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.drone = false;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, size * 1.6);
    this.controls.update();
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.bloom.enabled = q !== 'low';
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
    this.fly(dt);
    this.controls.update();
    // The resize observer misses some changes (display scaling, moving to another
    // monitor, some window snaps). If the canvas is out of sync with its box, part
    // of it would stay black — so check every frame and fix it before drawing.
    const cv = this.renderer.domElement;
    const pr = this.targetPixelRatio();
    if (
      this.container.clientWidth !== this.sizeW ||
      this.container.clientHeight !== this.sizeH ||
      this.renderer.getPixelRatio() !== pr ||
      cv.width !== Math.floor(this.sizeW * pr) ||
      cv.height !== Math.floor(this.sizeH * pr)
    ) {
      this.resize();
    }
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.sizeW, this.sizeH);
    if (this.quality === 'low') this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }

  get beamCount() {
    return this.beams.beamCount;
  }

  /** Pixel ratio for the current quality and screen (changes when moving between monitors). */
  private targetPixelRatio() {
    return this.quality === 'high' ? Math.min(devicePixelRatio || 1, 2) : 1;
  }

  private sizeW = 0;
  private sizeH = 0;

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.sizeW = w;
    this.sizeH = h;
    this.renderer.setPixelRatio(this.targetPixelRatio());
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
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export interface GizmoChange {
  position?: Vec3;
  /** Degrees: yaw (around vertical) and pitch (laser aim up/down). */
  rotation?: [number, number];
  /** Multiplier relative to the size when the drag started. */
  scale?: Vec3;
}
