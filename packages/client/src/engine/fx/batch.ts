// One draw call per material: a quad expanded per particle in the vertex shader.
//
// Particles are written in WORLD space, so the batch's own node never moves and
// needs no matrix update -- which is what keeps this clear of the built world's
// frozen-matrix rules entirely (docs/engine/rendering.md#a-static-world).
//
// The shading follows MW3's own zfeather particle shaders, disassembled from the
// game: colour is texture times vertex colour, alpha is texture alpha times vertex
// alpha, straight (not premultiplied), fog blends the colour toward the fog colour.

import * as THREE from "three";
import { keepAlpha } from "../../scene/importedMaterials.js";
import type { ParticleView } from "./emitter.js";

const VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iRot;
attribute vec4 iColor;
attribute float iFrame;
attribute float iMode;
attribute vec3 iAxisA;
attribute vec3 iAxisB;

uniform vec2 atlasGrid;
uniform float featherDepth;

varying vec2 vUv;
varying vec4 vColor;

// The authored colour is display-referred, as a hex colour is: linearise it the
// way THREE.Color linearises the sky, or the output transfer brightens it twice.
vec3 srgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
}

void main() {
  // Corners at +-1: size is a half-extent (FX_GenQuadVerts builds
  // origin +- size0*A +- size1*B), so the quad is twice size on each side. The
  // corner is scaled, then turned: A = cos*P2 + sin*P3 and up = -sin*P2 + cos*P3,
  // an anticlockwise turn of the scaled corner. Turning first and scaling after
  // skews a non-square sprite.
  vec2 sq = position.xy * iSize;
  float c = cos(iRot);
  float s = sin(iRot);
  vec2 rq = vec2(sq.x * c - sq.y * s, sq.x * s + sq.y * c);

  // Must be named mvPosition: the fog_vertex chunk below reads exactly that
  // identifier. Call it anything else and the shader fails to compile the moment
  // the world has fog -- and a batch whose program never links simply does not
  // draw, while the system goes on simulating particles perfectly happily.
  vec4 mvPosition;
  if (iMode < 0.5) {
    mvPosition = modelViewMatrix * vec4(iPos, 1.0);
    mvPosition.xy += rq;
  } else if (iMode < 1.5) {
    // Oriented: the quad lies in the run frame's axis[1] / axis[2] plane.
    vec3 world = iPos + iAxisA * rq.x + iAxisB * rq.y;
    mvPosition = modelViewMatrix * vec4(world, 1.0);
  } else {
    // Tail: half-length size1 along the velocity, half-width size0 across it
    // facing the camera, with the centre pulled back by its own half-length.
    vec3 toCamera = cameraPosition - iPos;
    vec3 side = cross(iAxisA, toCamera);
    float sideLength = length(side);
    side = sideLength > 1e-6 ? side / sideLength : vec3(0.0);
    vec3 centre = iPos - iAxisA * iSize.y;
    vec3 world = centre + side * (position.x * iSize.x) + iAxisA * (position.y * iSize.y);
    mvPosition = modelViewMatrix * vec4(world, 1.0);
  }
  gl_Position = projectionMatrix * mvPosition;

  // Atlas cell: column is the low bits, row the rest. D3D counts rows from the
  // top of the sheet; three's textures are flipped, so row 0 is the top band.
  float cols = max(atlasGrid.x, 1.0);
  float rows = max(atlasGrid.y, 1.0);
  float frame = floor(iFrame + 0.5);
  float column = mod(frame, cols);
  float row = floor(frame / cols);
  vUv = vec2((uv.x + column) / cols, (uv.y + rows - 1.0 - row) / rows);

  // zfeather's near-camera fade: a sprite fades out over featherDepth as it
  // reaches the eye, which is what stops a sheet the camera walks through from
  // filling the screen.
  float nearFade = featherDepth > 0.0 ? clamp(-mvPosition.z / featherDepth, 0.0, 1.0) : 1.0;
  vColor = vec4(srgbToLinear(iColor.rgb), iColor.a * nearFade);

  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 texel = texture2D(map, vUv);
  gl_FragColor = texel * vColor;
  // The materials' alpha test is gt0: only a fully transparent texel is dropped.
  if (gl_FragColor.a <= 0.0) discard;

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// fog_vertex needs vFogDepth declared; the stock pars chunks assume the standard
// materials' locals, so they come in by hand.
const VERTEX_PARS = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

/** The game's blend factor names, as the material dump spells them. */
const FACTORS: Record<string, THREE.BlendingDstFactor> = {
  zero: THREE.ZeroFactor,
  one: THREE.OneFactor,
  srccolor: THREE.SrcColorFactor,
  invsrccolor: THREE.OneMinusSrcColorFactor,
  srcalpha: THREE.SrcAlphaFactor,
  invsrcalpha: THREE.OneMinusSrcAlphaFactor,
  destalpha: THREE.DstAlphaFactor,
  invdestalpha: THREE.OneMinusDstAlphaFactor,
  destcolor: THREE.DstColorFactor,
  invdestcolor: THREE.OneMinusDstColorFactor,
};

const EQUATIONS: Record<string, THREE.BlendingEquation> = {
  add: THREE.AddEquation,
  subtract: THREE.SubtractEquation,
  revsubtract: THREE.ReverseSubtractEquation,
  min: THREE.MinEquation,
  max: THREE.MaxEquation,
};

export interface FxMaterialOptions {
  /** The material's own RGB blend, as the game names it. */
  blendOp: string;
  blendSrc: string;
  blendDst: string;
  doubleSided: boolean;
  fog: boolean;
  /** Metres; 0 for none. */
  featherDepth: number;
}

/**
 * The material one batch draws with.
 *
 * Not tone-mapped. A particle's colour is display-referred, like the sky's: the
 * sky is `scene.background`, which three never tone-maps, and fog blends toward
 * it after tone mapping. Put through the world's curve instead, dome's authored
 * tan (0.79, 0.67, 0.55) is multiplied by its `exposure: 0.35` on the way and
 * lands as dark grey against a light sky. A `ShaderMaterial` still, for the
 * output colour-space conversion and fog the standard prefix brings in.
 */
export function fxMaterial(map: THREE.Texture, opts: FxMaterialOptions, atlas: { cols: number; rows: number }): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: null },
        atlasGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
        featherDepth: { value: opts.featherDepth },
      },
    ]),
    vertexShader: VERTEX_PARS + VERTEX,
    fragmentShader: FRAGMENT_PARS + FRAGMENT,
    transparent: true,
    toneMapped: false,
    depthWrite: false,
    depthTest: true,
    // The particle quads are built facing the camera, but their winding is not
    // guaranteed once rotated or laid along a tail; nothing is gained by culling.
    side: THREE.DoubleSide,
    fog: opts.fog,
  });
  mat.uniforms.map!.value = map;

  // The game's own factors, one to one. The zfeather shaders output straight
  // colour, so (srcalpha, invsrcalpha) is an ordinary alpha blend and
  // (one, invsrcalpha) really does add the full colour.
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = EQUATIONS[opts.blendOp] ?? THREE.AddEquation;
  mat.blendSrc = (FACTORS[opts.blendSrc] ?? THREE.SrcAlphaFactor) as THREE.BlendingSrcFactor;
  mat.blendDst = FACTORS[opts.blendDst] ?? THREE.OneMinusSrcAlphaFactor;
  // The canvas is premultiplied `alpha: true`: leave its alpha exactly as the
  // world pass wrote it, or a sheet punches a hole the page shows through.
  keepAlpha(mat);
  return mat;
}

/** A pool of quads sharing one material, refilled every frame from live particles. */
export class FxBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly attrs: Record<"pos" | "size" | "rot" | "color" | "frame" | "mode" | "axisA" | "axisB", THREE.InstancedBufferAttribute>;
  private n = 0;

  constructor(
    readonly material: THREE.ShaderMaterial,
    readonly capacity: number,
    sortOrder: number,
  ) {
    this.geometry = new THREE.InstancedBufferGeometry();
    // Corners at +-1, because size is a half-extent.
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    this.geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.geometry.setIndex(quad.getIndex());
    quad.dispose();

    const attr = (name: string, items: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, a);
      return a;
    };
    this.attrs = {
      pos: attr("iPos", 3),
      size: attr("iSize", 2),
      rot: attr("iRot", 1),
      color: attr("iColor", 4),
      frame: attr("iFrame", 1),
      mode: attr("iMode", 1),
      axisA: attr("iAxisA", 3),
      axisB: attr("iAxisB", 3),
    };

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.matrixAutoUpdate = false;
    // A mover must not cast: shadowMap.autoUpdate is false, so its shadow would
    // stay behind where the particle was.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 1000 + sortOrder;
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  /** Append one particle. Silently full past `capacity`, which the system budgets against. */
  push(v: ParticleView): void {
    const i = this.n;
    if (i >= this.capacity) {
      return;
    }
    const { pos, size, rot, color, frame, mode, axisA, axisB } = this.attrs;
    pos.array[i * 3] = v.x;
    pos.array[i * 3 + 1] = v.y;
    pos.array[i * 3 + 2] = v.z;
    size.array[i * 2] = v.w;
    size.array[i * 2 + 1] = v.h;
    rot.array[i] = v.rot;
    color.array[i * 4] = v.r;
    color.array[i * 4 + 1] = v.g;
    color.array[i * 4 + 2] = v.b;
    color.array[i * 4 + 3] = v.a;
    frame.array[i] = v.frame;
    mode.array[i] = v.mode;
    axisA.array[i * 3] = v.ax;
    axisA.array[i * 3 + 1] = v.ay;
    axisA.array[i * 3 + 2] = v.az;
    axisB.array[i * 3] = v.bx;
    axisB.array[i * 3 + 1] = v.by;
    axisB.array[i * 3 + 2] = v.bz;
    this.n++;
  }

  /** Upload what was pushed and draw that many. */
  end(): void {
    this.geometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) {
      return;
    }
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get count(): number {
    return this.n;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
