// Builds three.js meshes for stage elements and fixtures, and animates the
// parts that react to the show (LED screens, crowd).

import * as THREE from 'three';
import type { Fixture, Stage, StageElement } from '../core/types';
import { hash2, rad } from '../core/util';

const screenFragment = /* glsl */ `
  uniform float uTime;
  uniform float uBeat;
  uniform float uFlash;
  uniform float uLevel;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform int uMode;
  varying vec2 vUv;
  void main() {
    float pulse = pow(1.0 - fract(uBeat), 3.0);
    vec3 c = vec3(0.0);
    if (uMode == 0) {
      float d = length(vUv - 0.5);
      float ring = smoothstep(0.04, 0.0, abs(d - fract(uBeat) * 0.7));
      c = mix(uColorA, uColorB, vUv.y) * (0.15 + 0.5 * pulse) + uColorB * ring;
    } else if (uMode == 1) {
      float col = floor(vUv.x * 16.0);
      float h = 0.25 + 0.6 * fract(sin(col * 12.9898 + floor(uBeat * 2.0) * 78.233) * 43758.5453) * (0.4 + uLevel);
      float bar = step(vUv.y, h) * step(0.08, fract(vUv.x * 16.0));
      c = mix(uColorA, uColorB, vUv.y) * bar * (0.4 + 0.6 * pulse);
    } else if (uMode == 2) {
      float t = uTime * 0.15;
      c = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + vUv.x * 0.6 + t));
      c *= 0.18 + 0.3 * pulse;
    }
    c += vec3(uFlash);
    gl_FragColor = vec4(c, 1.0);
  }
`;
const screenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const SCREEN_MODES = { pulse: 0, bars: 1, gradient: 2, off: 3 } as const;

export interface Pickable {
  kind: 'element' | 'fixture';
  id: string;
}

export class StageBuilder {
  readonly group = new THREE.Group();
  readonly fixtureGroup = new THREE.Group();
  private screens: THREE.ShaderMaterial[] = [];
  private crowds: { mesh: THREE.InstancedMesh; base: THREE.Matrix4[]; phase: number[] }[] = [];
  private spill: THREE.PointLight[] = [];
  readonly meshes = new Map<string, THREE.Object3D>();
  private ambient = new THREE.HemisphereLight(0x8090ff, 0x101010, 0.2);
  floorY = 0;
  private ambientLevel = 0.2;
  /** Stage-design mode: light everything evenly. */
  workLights = false;

  private work = new THREE.DirectionalLight(0xffffff, 0);

  constructor() {
    this.work.position.set(10, 30, 25);
    this.group.add(this.ambient, this.work, this.work.target, this.fixtureGroup);
  }

  build(stage: Stage, fixtures: Fixture[]) {
    for (const child of [...this.group.children]) {
      if (child === this.ambient || child === this.work || child === this.work.target || child === this.fixtureGroup) continue;
      this.group.remove(child);
      dispose(child);
    }
    for (const child of [...this.fixtureGroup.children]) {
      this.fixtureGroup.remove(child);
      dispose(child);
    }
    this.meshes.clear();
    this.screens = [];
    this.crowds = [];
    this.spill = [];
    this.ambientLevel = 0.15 + stage.ambient * 2.5;
    this.ambient.intensity = this.ambientLevel;
    const floor = stage.elements.find((e) => e.kind === 'floor');
    this.floorY = floor ? floor.position[1] + floor.size[1] : 0;

    for (const el of stage.elements) {
      const obj = this.buildElement(el);
      obj.userData.pick = { kind: 'element', id: el.id } satisfies Pickable;
      obj.traverse((o) => (o.userData.pick = { kind: 'element', id: el.id }));
      this.meshes.set(el.id, obj);
      this.group.add(obj);
    }
    for (const f of fixtures) {
      const obj = this.buildFixture(f);
      this.meshes.set(f.id, obj);
      this.fixtureGroup.add(obj);
    }
    // Coloured spill light so beams tint the stage. Limited for performance.
    for (const f of fixtures.slice(0, 8)) {
      const l = new THREE.PointLight(0xffffff, 0, 40, 1.6);
      l.position.set(f.position[0], f.position[1], f.position[2] + 0.5);
      l.userData.fixtureId = f.id;
      this.spill.push(l);
      this.group.add(l);
    }
  }

  private buildElement(el: StageElement): THREE.Object3D {
    const [w, h, d] = el.size;
    const color = new THREE.Color(el.color);
    const root = new THREE.Group();
    root.position.set(el.position[0], el.position[1], el.position[2]);
    root.rotation.y = rad(el.rotation);
    const solid = (geo: THREE.BufferGeometry, mat?: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat ?? new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.1 }));
      root.add(m);
      return m;
    };
    switch (el.kind) {
      case 'floor': {
        const m = solid(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.3 }));
        m.position.y = h / 2;
        break;
      }
      case 'platform':
      case 'wall':
      case 'speaker': {
        const m = solid(new THREE.BoxGeometry(w, h, d));
        m.position.y = h / 2;
        if (el.kind === 'speaker') {
          // Speaker cones on the front face.
          const coneMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.4 });
          const n = Math.max(1, Math.floor(h / (w * 0.9)));
          for (let i = 0; i < n; i++) {
            const c = new THREE.Mesh(new THREE.CircleGeometry(w * 0.36, 20), coneMat);
            c.position.set(0, (h / n) * (i + 0.5), d / 2 + 0.01);
            root.add(c);
          }
        }
        break;
      }
      case 'pillar': {
        const m = solid(new THREE.CylinderGeometry(w / 2, w / 2, h, 16));
        m.position.y = h / 2;
        break;
      }
      case 'truss': {
        const metal = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.9 });
        const t = Math.min(h, d) * 0.12;
        for (const [y, z] of [
          [0, -d / 2],
          [0, d / 2],
          [h, -d / 2],
          [h, d / 2],
        ]) {
          const chord = solid(new THREE.BoxGeometry(w, t, t), metal);
          chord.position.set(0, y, z);
        }
        // Zig-zag lacing.
        const segs = Math.max(2, Math.round(w / Math.max(h, 0.3)));
        for (let i = 0; i < segs; i++) {
          for (const z of [-d / 2, d / 2]) {
            const len = Math.hypot(w / segs, h);
            const brace = solid(new THREE.BoxGeometry(t * 0.6, len, t * 0.6), metal);
            brace.position.set(-w / 2 + (w / segs) * (i + 0.5), h / 2, z);
            brace.rotation.z = (i % 2 ? 1 : -1) * Math.atan2(w / segs, h);
          }
        }
        break;
      }
      case 'screen': {
        const frame = solid(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.9 }));
        frame.position.y = h / 2;
        const mat = new THREE.ShaderMaterial({
          vertexShader: screenVertex,
          fragmentShader: screenFragment,
          uniforms: {
            uTime: { value: 0 },
            uBeat: { value: 0 },
            uFlash: { value: 0 },
            uLevel: { value: 0 },
            uColorA: { value: new THREE.Color('#2040ff') },
            uColorB: { value: new THREE.Color('#ff20a0') },
            uMode: { value: SCREEN_MODES[el.screenMode ?? 'pulse'] },
          },
        });
        const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.96, h * 0.94), mat);
        face.position.set(0, h / 2, d / 2 + 0.01);
        root.add(face);
        this.screens.push(mat);
        break;
      }
      case 'crowd': {
        const density = el.density ?? 0.6;
        const count = Math.min(4000, Math.round(w * d * density * 1.1));
        const geo = new THREE.CapsuleGeometry(0.22, h * 0.6, 3, 6);
        geo.translate(0, h * 0.5, 0);
        const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 1 }), count);
        const base: THREE.Matrix4[] = [];
        const phase: number[] = [];
        const m = new THREE.Matrix4();
        for (let i = 0; i < count; i++) {
          const x = (hash2(i, 1) - 0.5) * w;
          const z = (hash2(i, 2) - 0.5) * d;
          const s = 0.85 + hash2(i, 3) * 0.3;
          m.makeScale(s, s, s).setPosition(x, 0, z);
          mesh.setMatrixAt(i, m);
          base.push(m.clone());
          phase.push(hash2(i, 4));
        }
        root.add(mesh);
        this.crowds.push({ mesh, base, phase });
        break;
      }
    }
    return root;
  }

  private buildFixture(f: Fixture): THREE.Object3D {
    const root = new THREE.Group();
    root.position.set(f.position[0], f.position[1], f.position[2]);
    root.rotation.order = 'YXZ';
    root.rotation.y = rad(f.aim[0]);
    root.rotation.x = -rad(f.aim[1]);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.55), new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.5, metalness: 0.6 }));
    body.position.z = -0.25;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), new THREE.MeshBasicMaterial({ color: 0x444444 }));
    lens.position.z = 0.03;
    root.add(body, lens);
    root.traverse((o) => (o.userData.pick = { kind: 'fixture', id: f.id } satisfies Pickable));
    root.userData.lens = lens;
    root.userData.body = body;
    return root;
  }

  setSelection(ids: Set<string>) {
    for (const [id, obj] of this.meshes) {
      const sel = ids.has(id);
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
          o.material.emissive.set(sel ? 0x2a6cff : 0x000000);
          o.material.emissiveIntensity = sel ? 0.6 : 0;
        }
      });
    }
  }

  /** Per-frame animation. `fixtureColors` is the average beam colour per fixture. */
  animate(time: number, beat: number, flash: number, level: number, fixtureColors: Map<string, THREE.Color>) {
    this.ambient.intensity = this.workLights ? Math.max(this.ambientLevel, 1.6) : this.ambientLevel;
    this.work.intensity = this.workLights ? 2.4 : 0;
    for (const mat of this.screens) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uBeat.value = beat;
      mat.uniforms.uFlash.value = flash;
      mat.uniforms.uLevel.value = level;
    }
    const m = new THREE.Matrix4();
    const bounce = Math.pow(1 - (((beat % 1) + 1) % 1), 2);
    for (const c of this.crowds) {
      for (let i = 0; i < c.base.length; i++) {
        m.copy(c.base[i]);
        // People bounce on the beat, some more than others.
        const jump = c.phase[i] > 0.35 ? bounce * 0.12 * c.phase[i] : 0;
        m.elements[13] += jump;
        c.mesh.setMatrixAt(i, m);
      }
      c.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const l of this.spill) {
      const col = fixtureColors.get(l.userData.fixtureId);
      if (col) {
        l.color.copy(col);
        l.intensity = Math.min(3, col.r + col.g + col.b) * 1.2;
      } else l.intensity = 0;
    }
    for (const obj of this.fixtureGroup.children) {
      const lens = obj.userData.lens as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      const pick = obj.userData.pick as Pickable | undefined;
      const col = pick ? fixtureColors.get(pick.id) : undefined;
      lens.material.color.set(col ? col.clone().multiplyScalar(3) : new THREE.Color(0x333333));
    }
  }
}

function dispose(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
