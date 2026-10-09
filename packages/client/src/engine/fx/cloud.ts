// Particle clouds: T5's CLOUD elem, a rigid swarm of tiny quads per particle.
//
// Every cloud draws a window of one shared buffer of 2 x 1024 points in [-1, 1]^3:
// a jittered 8x8x16 grid scattered by a 10-bit LFSR, then a clipped gaussian
// (R_InitParticleCloudBuffer, reverse/t5-fx#cloud). A cloud places that window
// with its own origin, axes and scale, so the points never move on their own.
// One mesh per cloud, all sharing the buffer's attributes: a draw range and a
// handful of uniforms are all that differ, and three uploads the buffer once.

import * as THREE from "three";
import { keepAlpha } from "../../scene/importedMaterials.js";
import { seeded } from "./library.js";

export const CLOUD_POINTS = 1024;

/** Where the n-th uniform point goes: 0, then a 10-bit LFSR from 0x1ff, which visits every other slot once. */
export function cloudSlots(): number[] {
  const slots = [0];
  let s = 0x1ff;
  for (let n = 1; n < CLOUD_POINTS; n++) {
    s = (s >> 1) ^ (s & 1 ? 0x240 : 0);
    slots.push(s & 0x3ff);
  }
  return slots;
}

/**
 * The 2048 points: the uniform half (slots 0..1023), then the gaussian half. The
 * game seeds them from whatever ran before it, so only their distribution is the
 * game's; a fixed seed keeps screenshots identical run to run.
 */
export function cloudPoints(seed = 1): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(2 * CLOUD_POINTS * 3);
  const slots = cloudSlots();
  let n = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      for (let k = 0; k < 16; k++) {
        const at = slots[n++]! * 3;
        out[at] = (i + rand()) / 4 - 1;
        out[at + 1] = (j + rand()) / 4 - 1;
        out[at + 2] = (k + rand()) / 8 - 1;
      }
    }
  }
  // Marsaglia's polar method, a quarter of a standard normal, clipped to the cube.
  const normal = (): number => {
    for (;;) {
      const u = rand() * 2 - 1;
      const v = rand() * 2 - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        return u * Math.sqrt((-2 * Math.log(s)) / s);
      }
    }
  };
  for (let q = CLOUD_POINTS; q < 2 * CLOUD_POINTS; q++) {
    for (let c = 0; c < 3; c++) {
      out[q * 3 + c] = Math.min(Math.max(0.25 * normal(), -1), 1);
    }
  }
  return out;
}

/** The buffer as quads: four vertices per point, each carrying the point and its corner. */
export function cloudGeometry(): { point: THREE.BufferAttribute; corner: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const points = cloudPoints();
  const quads = 2 * CLOUD_POINTS;
  const point = new Float32Array(quads * 4 * 3);
  const corner = new Float32Array(quads * 4 * 2);
  const index = new Uint16Array(quads * 6);
  // Corners in D3D's uv order: (0,0), (0,1), (1,0), (1,1); drawn 0-1-2, 2-1-3.
  const uv = [0, 0, 0, 1, 1, 0, 1, 1];
  for (let q = 0; q < quads; q++) {
    for (let v = 0; v < 4; v++) {
      point.set(points.subarray(q * 3, q * 3 + 3), (q * 4 + v) * 3);
      corner[(q * 4 + v) * 2] = uv[v * 2]!;
      corner[(q * 4 + v) * 2 + 1] = uv[v * 2 + 1]!;
    }
    index.set(
      [0, 1, 2, 2, 1, 3].map((i) => q * 4 + i),
      q * 6,
    );
  }
  return {
    point: new THREE.BufferAttribute(point, 3),
    corner: new THREE.BufferAttribute(corner, 2),
    index: new THREE.BufferAttribute(index, 1),
  };
}

const VERTEX = /* glsl */ `
attribute vec3 point;
attribute vec2 corner;

uniform vec3 origin;
uniform mat3 axes;
uniform float scale;
uniform vec2 size;
uniform vec3 streak;

varying vec2 vUv;

void main() {
  vec3 world = origin + scale * (axes * point);
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);

  // particleCloudMatrix: two view-space axes. Square, size0 wide and size1 tall
  // (half a sprite's span for the same numbers), unless the size is non-uniform
  // and the cloud moves: then a streak along its motion, size0 across.
  vec2 a = vec2(size.x, 0.0);
  vec2 b = vec2(0.0, size.y);
  if (size.x != size.y) {
    vec2 v = (viewMatrix * vec4(streak, 0.0)).xy;
    // A signed test, as both builds have it.
    if (!(v.x < 0.001 && v.y < 0.001)) {
      float len = length(v);
      a = vec2(v.y, -v.x) * size.x / len;
      b = len < size.x ? v / len * size.x : v;
    }
  }
  mvPosition.xy += (corner.x - 0.5) * a + (corner.y - 0.5) * b;
  gl_Position = projectionMatrix * mvPosition;

  // D3D's v = 0 is the image's top row and runs along +b, screen up: a cloud's
  // flake is drawn upside down against a sprite's.
  vUv = vec2(corner.x, 1.0 - corner.y);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform vec4 color;

varying vec2 vUv;

vec3 srgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
}

void main() {
  vec4 c = texture2D(map, vUv) * vec4(srgbToLinear(color.rgb), color.a);
#ifdef OUTPUT_ALPHA
  // particle_cloud_add: colour times alpha, blended one/one, in display space.
  vec3 rgb = linearToOutputTexel(vec4(c.rgb, 1.0)).rgb;
  gl_FragColor = vec4(rgb * c.a, c.a);
#else
  gl_FragColor = c;
  if (gl_FragColor.a <= 0.0) discard;
  #include <colorspace_fragment>
#endif
}
`;

const FACTORS: Record<string, THREE.BlendingDstFactor> = {
  zero: THREE.ZeroFactor,
  one: THREE.OneFactor,
  srcalpha: THREE.SrcAlphaFactor,
  invsrcalpha: THREE.OneMinusSrcAlphaFactor,
  srccolor: THREE.SrcColorFactor,
  invsrccolor: THREE.OneMinusSrcColorFactor,
  destcolor: THREE.DstColorFactor,
  invdestcolor: THREE.OneMinusDstColorFactor,
};

export interface FxCloudMaterialOptions {
  output?: "straight" | "alpha" | "luma";
  blendSrc: string;
  blendDst: string;
}

/** What one cloud needs drawn this frame: everything else is the shared buffer. */
export interface CloudView {
  x: number;
  y: number;
  z: number;
  /** axis0, axis1, axis2 in engine space, column after column. */
  axes: number[];
  /** Metres: the cube's half-extent. */
  scale: number;
  /** Metres: size0 wide, size1 tall. */
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
  a: number;
  /** Which of the 1024 points, and which half. */
  offset: number;
  count: number;
  gaussian: boolean;
  /** `-direction * size1`, world space: the streak a moving non-uniform cloud draws. */
  sx: number;
  sy: number;
  sz: number;
}

export function emptyCloudView(): CloudView {
  return {
    x: 0,
    y: 0,
    z: 0,
    axes: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: 0,
    w: 0,
    h: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    offset: 0,
    count: 0,
    gaussian: false,
    sx: 0,
    sy: 0,
    sz: 0,
  };
}

/** A pool of cloud meshes sharing one material's look, refilled every frame. */
export class FxCloudBatch {
  readonly root = new THREE.Group();
  private readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private n = 0;

  constructor(
    map: THREE.Texture,
    buffer: ReturnType<typeof cloudGeometry>,
    opts: FxCloudMaterialOptions,
    readonly capacity: number,
    sortOrder: number,
  ) {
    this.root.name = "fx clouds";
    this.root.matrixAutoUpdate = false;
    const base = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        color: { value: new THREE.Vector4(1, 1, 1, 1) },
        origin: { value: new THREE.Vector3() },
        axes: { value: new THREE.Matrix3() },
        scale: { value: 1 },
        size: { value: new THREE.Vector2(1, 1) },
        streak: { value: new THREE.Vector3() },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: opts.output === "alpha" ? { OUTPUT_ALPHA: "" } : {},
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: (FACTORS[opts.blendSrc] ?? THREE.SrcAlphaFactor) as THREE.BlendingSrcFactor,
      blendDst: FACTORS[opts.blendDst] ?? THREE.OneMinusSrcAlphaFactor,
    });
    keepAlpha(base);
    for (let i = 0; i < capacity; i++) {
      // Each its own geometry for its own draw range, over the same attributes.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("point", buffer.point);
      geometry.setAttribute("corner", buffer.corner);
      geometry.setIndex(buffer.index);
      const material = i === 0 ? base : base.clone();
      if (i > 0) {
        material.uniforms.map!.value = map;
        keepAlpha(material);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.renderOrder = 1000 + sortOrder;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
  }

  begin(): void {
    this.n = 0;
  }

  push(v: CloudView): void {
    const mesh = this.meshes[this.n];
    if (!mesh) {
      return;
    }
    this.n++;
    const u = mesh.material.uniforms;
    (u.origin!.value as THREE.Vector3).set(v.x, v.y, v.z);
    (u.axes!.value as THREE.Matrix3).fromArray(v.axes);
    u.scale!.value = v.scale;
    (u.size!.value as THREE.Vector2).set(v.w, v.h);
    (u.streak!.value as THREE.Vector3).set(v.sx, v.sy, v.sz);
    (u.color!.value as THREE.Vector4).set(v.r, v.g, v.b, v.a);
    const first = (v.gaussian ? CLOUD_POINTS : 0) + v.offset;
    mesh.geometry.setDrawRange(first * 6, v.count * 6);
    mesh.visible = true;
  }

  end(): void {
    for (let i = this.n; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
    }
  }

  get count(): number {
    return this.n;
  }

  /** The shared attributes belong to whoever built them; each mesh's own geometry and material are freed here. */
  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
