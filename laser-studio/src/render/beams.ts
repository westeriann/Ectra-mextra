// Instanced beam rendering: every beam on stage is one instance of a thin,
// slightly diverging open cylinder drawn with additive blending. Floor hits
// are drawn as soft dots where beams land.

import * as THREE from 'three';
import type { Fixture, FixtureFrame } from '../core/types';
import { rad } from '../core/util';

const MAX_BEAMS = 12000;
const MAX_LENGTH = 140;

const beamVertex = /* glsl */ `
  varying float vAlong;
  varying float vEdge;
  varying vec3 vColor;
  void main() {
    vAlong = position.y;
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
  varying float vAlong;
  varying float vEdge;
  varying vec3 vColor;
  void main() {
    float core = pow(vEdge, 2.2);
    float fade = pow(1.0 - vAlong, 1.35);
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
  /** Height of the floor beams land on. */
  floorY = 0;

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

  update(fixtures: Fixture[], frames: FixtureFrame[]) {
    let n = 0;
    let s = 0;
    const byId = new Map(fixtures.map((f) => [f.id, f]));
    for (const fr of frames) {
      const f = byId.get(fr.fixtureId);
      if (!f) continue;
      for (const b of fr.beams) {
        if (n >= MAX_BEAMS) break;
        BeamLayer.direction(f, b.x, b.y, this.dir);
        let len = MAX_LENGTH;
        const hitsFloor = this.dir.y < -0.01 && f.position[1] > this.floorY;
        if (hitsFloor) len = Math.min(len, (f.position[1] - this.floorY) / -this.dir.y);
        this.q.setFromUnitVectors(this.up, this.dir);
        const width = 0.012 + len * 0.0012;
        this.pos.set(f.position[0], f.position[1], f.position[2]);
        this.scl.set(width, len, width);
        this.m.compose(this.pos, this.q, this.scl);
        this.beams.setMatrixAt(n, this.m);
        this.col.setRGB(b.r * b.a, b.g * b.a, b.b * b.a);
        this.beams.setColorAt(n, this.col);
        n++;
        if (hitsFloor && s < MAX_BEAMS) {
          const size = 0.25 + len * 0.012;
          this.pos.set(f.position[0] + this.dir.x * len, this.floorY + 0.02, f.position[2] + this.dir.z * len);
          this.m.compose(this.pos, this.q.identity(), this.scl.set(size, 1, size));
          this.spots.setMatrixAt(s, this.m);
          this.spots.setColorAt(s, this.col);
          s++;
        }
      }
    }
    this.beams.count = n;
    this.spots.count = s;
    this.beams.instanceMatrix.needsUpdate = true;
    this.beams.instanceColor!.needsUpdate = true;
    this.spots.instanceMatrix.needsUpdate = true;
    this.spots.instanceColor!.needsUpdate = true;
  }

  get beamCount() {
    return this.beams.count;
  }
}
