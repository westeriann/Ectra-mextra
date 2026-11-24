// Instanced beam rendering: every beam on stage is one instance of a thin,
// slightly diverging open cylinder drawn with additive blending. Floor hits
// are drawn as soft dots where beams land.

import * as THREE from 'three';
import { DEFAULT_TRACE, traceBeam, type TraceScene, type V3 } from '../core/trace';
import type { Fixture, FixtureFrame } from '../core/types';
import { rad } from '../core/util';

const MAX_BEAMS = 12000;
const MAX_LENGTH = 140;

const beamVertex = /* glsl */ `
  attribute vec2 aFade; // x: distance travelled before this segment, y: segment length
  varying float vDist;
  varying float vEdge;
  varying vec3 vColor;
  void main() {
    vDist = (aFade.x + position.y * aFade.y) / ${MAX_LENGTH.toFixed(1)};
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vec3 toCam = normalize(cameraPosition - world.xyz);
    // Bright in the middle of the beam, fading towards the silhouette edges.
    vEdge = abs(dot(n, toCam));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const beamFragment = /* glsl */ `
  uniform float uHaze;
  varying float vDist;
  varying float vEdge;
  varying vec3 vColor;
  void main() {
    float core = pow(vEdge, 2.2);
    float fade = pow(1.0 - clamp(vDist, 0.0, 1.0), 1.35);
    float a = core * fade * uHaze;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const spotFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(vColor * a * a * 0.5, 1.0);
  }
`;

const spotVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

export class BeamLayer {
  readonly group = new THREE.Group();
  private beams: THREE.InstancedMesh;
  private spots: THREE.InstancedMesh;
  private beamMat: THREE.ShaderMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private dir = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private col = new THREE.Color();
  private fade: THREE.InstancedBufferAttribute;
  private normal = new THREE.Vector3();
  /** Stage geometry beams can hit, bounce off or split on. */
  scene: TraceScene = { floorY: 0, boxes: [], mirrors: [], balls: [] };

  constructor() {
    // Unit cylinder from y=0 to y=1; narrow at the aperture, wider at the far end.
    const geo = new THREE.CylinderGeometry(1, 0.35, 1, 10, 1, true);
    geo.translate(0, 0.5, 0);
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: beamVertex,
      fragmentShader: beamFragment,
      uniforms: { uHaze: { value: 0.6 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.beams = new THREE.InstancedMesh(geo, this.beamMat, MAX_BEAMS);
    this.beams.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 2), 2);
    geo.setAttribute('aFade', this.fade);
    this.beams.frustumCulled = false;
    this.beams.count = 0;

    const spotGeo = new THREE.PlaneGeometry(1, 1);
    spotGeo.rotateX(-Math.PI / 2);
    const spotMat = new THREE.ShaderMaterial({
      vertexShader: spotVertex,
      fragmentShader: spotFragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.spots = new THREE.InstancedMesh(spotGeo, spotMat, MAX_BEAMS);
    this.spots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.spots.frustumCulled = false;
    this.spots.count = 0;
    this.spots.renderOrder = 1;

    this.group.add(this.beams, this.spots);
  }

  setHaze(h: number) {
    this.beamMat.uniforms.uHaze.value = 0.04 + h * 0.42;
  }

  /** World-space direction of a beam from a fixture's aim plus beam-local angles. */
  static direction(f: Fixture, x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const yaw = rad(f.aim[0] + x);
    const pitch = rad(f.aim[1] + y);
    return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }

  update(fixtures: Fixture[], frames: FixtureFrame[], time: number) {
    let n = 0;
    let s = 0;
    const byId = new Map(fixtures.map((f) => [f.id, f]));
    const opts = { ...DEFAULT_TRACE, time, budget: { segments: MAX_BEAMS } };
    for (const fr of frames) {
      const f = byId.get(fr.fixtureId);
      if (!f) continue;
      const origin: V3 = [f.position[0], f.position[1], f.position[2]];
      for (const b of fr.beams) {
        if (n >= MAX_BEAMS) break;
        BeamLayer.direction(f, b.x, b.y, this.dir);
        const segs = traceBeam(this.scene, origin, [this.dir.x, this.dir.y, this.dir.z], opts);
        for (const seg of segs) {
          if (n >= MAX_BEAMS) break;
          this.dir.set(seg.dir[0], seg.dir[1], seg.dir[2]);
          this.q.setFromUnitVectors(this.up, this.dir);
          // Beams widen with distance from the projector.
          const width = 0.012 + (seg.start + seg.length * 0.5) * 0.0012;
          this.pos.set(seg.origin[0], seg.origin[1], seg.origin[2]);
          this.scl.set(width, seg.length, width);
          this.m.compose(this.pos, this.q, this.scl);
          this.beams.setMatrixAt(n, this.m);
          const g = b.a * seg.gain;
          this.col.setRGB(b.r * g, b.g * g, b.b * g);
          this.beams.setColorAt(n, this.col);
          this.fade.setXY(n, seg.start, seg.length);
          n++;
          // Bright dot where the beam lands on a surface (not on mirrors — they pass the light on).
          const hit = seg.hit;
          if (hit && hit.kind !== 'mirror' && s < MAX_BEAMS) {
            const dist = seg.start + seg.length;
            const size = 0.25 + dist * 0.012;
            this.normal.set(hit.normal[0], hit.normal[1], hit.normal[2]);
            this.pos.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(this.normal, 0.02);
            this.q.setFromUnitVectors(this.up, this.normal);
            this.m.compose(this.pos, this.q, this.scl.set(size, 1, size));
            this.spots.setMatrixAt(s, this.m);
            const fadeAt = Math.pow(Math.max(0, 1 - dist / MAX_LENGTH), 1.35);
            this.col.multiplyScalar(fadeAt * 1.6);
            this.spots.setColorAt(s, this.col);
            s++;
          }
        }
      }
    }
    this.beams.count = n;
    this.spots.count = s;
    this.beams.instanceMatrix.needsUpdate = true;
    this.beams.instanceColor!.needsUpdate = true;
    this.fade.needsUpdate = true;
    this.spots.instanceMatrix.needsUpdate = true;
    this.spots.instanceColor!.needsUpdate = true;
  }

  get beamCount() {
    return this.beams.count;
  }
}
