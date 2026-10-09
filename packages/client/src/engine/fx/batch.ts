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
attribute vec4 iShape;
attribute vec3 iAxisA;
attribute vec3 iAxisB;

uniform vec2 atlasGrid;
uniform float featherDepth;
uniform float eyeOffset;
uniform vec3 falloff;
uniform vec3 falloffBegin;
uniform vec3 falloffEnd;

varying vec2 vUv;
varying vec4 vColor;
varying float vViewDepth;

// The authored colour is display-referred, as a hex colour is: linearise it the
// way THREE.Color linearises the sky, or the output transfer brightens it twice.
vec3 srgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
}

vec3 safeNormalize(vec3 v, vec3 fallback) {
  float l = length(v);
  return l > 1e-6 ? v / l : fallback;
}

void main() {
  // Corners at +-1: size is a half-extent (FX_GenQuadVerts builds
  // origin +- size0*A +- size1*B), so the quad is twice size on each side.
  // T5 narrows the top or bottom edge (iShape.xy, its trim) and moves the centre
  // by its pivot in units of A' and B', where B points down the sprite: so the
  // pivot's second half is negated in this y-up corner space. Then the corner is
  // scaled, then turned: A = cos*R + sin*U, an anticlockwise turn of the scaled
  // corner. Turning first and scaling after skews a non-square sprite.
  float trim = position.y > 0.0 ? iShape.x : iShape.y;
  vec2 sq = (vec2(position.x * trim, position.y) + vec2(iShape.z, -iShape.w)) * iSize;
  float c = cos(iRot);
  float s = sin(iRot);
  vec2 rq = vec2(sq.x * c - sq.y * s, sq.x * s + sq.y * c);

  // The camera's axes in world space: the rows of the view rotation.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  const vec3 worldUp = vec3(0.0, 1.0, 0.0);

  // Every type is GenSpriteVerts over a right (R) and up (U) axis, and a normal
  // (N) the falloff shaders read. Modes are DRAW_* in emitter.ts.
  int mode = int(iMode + 0.5);
  vec3 centre = iPos;
  vec3 R = camRight;
  vec3 U = camUp;
  vec3 N = camBack;
  if (mode == 1) {
    // Oriented (and rotated): the quad lies in the frame's axis[1] / axis[2] plane.
    R = iAxisA;
    U = iAxisB;
    N = cross(R, U);
  } else if (mode == 2 || mode == 3) {
    // Tail: half-length size1 along the velocity, centred size1 behind the
    // particle; a line is centred size1 ahead. Across it, facing the camera.
    centre = iPos + iAxisA * (mode == 2 ? -iSize.y : iSize.y);
    N = safeNormalize(cameraPosition - centre, camBack);
    R = safeNormalize(cross(iAxisA, cameraPosition - centre), camRight);
    U = iAxisA;
  } else if (mode >= 4) {
    vec3 toEye = safeNormalize(cameraPosition - iPos, camBack);
    if (mode == 4) {
      // Upright about the world's up, turned with the view's heading.
      R = safeNormalize(vec3(camBack.z, 0.0, -camBack.x), camRight);
      U = worldUp;
      N = camBack;
    } else if (mode == 5) {
      // Facing the eye rather than the view plane.
      U = camUp;
      R = safeNormalize(cross(U, toEye), camRight);
      N = toEye;
    } else {
      R = safeNormalize(vec3(toEye.z, 0.0, -toEye.x), camRight);
      U = worldUp;
      N = toEye;
    }
  }
  vec3 world = centre + R * rq.x + U * rq.y;

  // Must be named mvPosition: the fog_vertex chunk below reads exactly that
  // identifier. Call it anything else and the shader fails to compile the moment
  // the world has fog -- and a batch whose program never links simply does not
  // draw, while the system goes on simulating particles perfectly happily.
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);

  // zfeather's near-camera fade: a sprite fades out over featherDepth as it
  // reaches the eye, which is what stops a sheet the camera walks through from
  // filling the screen. It reads the depth before the eye offset moves it.
  float viewDepth = -mvPosition.z;
  vViewDepth = viewDepth;
  float nearFade = featherDepth > 0.0 ? clamp(viewDepth / featherDepth, 0.0, 1.0) : 1.0;

  // T5's eyeoffset: pull the vertex eyeOffset toward the eye along its own ray,
  // so it draws over what it would have been buried in at the same screen size.
  if (eyeOffset > 0.0 && viewDepth > eyeOffset) {
    mvPosition.xyz *= (viewDepth - eyeOffset) / viewDepth;
  }
  gl_Position = projectionMatrix * mvPosition;

  // Atlas cell: column is the low bits, row the rest. D3D counts rows from the
  // top of the sheet; three's textures are flipped, so row 0 is the top band.
  // A trimmed edge samples the middle of its cell, as its corners move inwards.
  float cols = max(atlasGrid.x, 1.0);
  float rows = max(atlasGrid.y, 1.0);
  float frame = floor(iFrame + 0.5);
  float column = mod(frame, cols);
  float row = floor(frame / cols);
  float u = 0.5 + (uv.x - 0.5) * trim;
  vUv = vec2((u + column) / cols, (uv.y + rows - 1.0 - row) / rows);

  vec4 color = vec4(srgbToLinear(iColor.rgb), iColor.a * nearFade);
  if (falloff.z > 0.0) {
    // T5's falloff: fade and tint a sprite by how squarely it faces the eye.
    float facing = dot(safeNormalize(cameraPosition - world, N), N);
    float f = clamp(facing * facing * falloff.x + falloff.y, 0.0, 1.0);
    color.rgb *= srgbToLinear(mix(falloffEnd, falloffBegin, f));
    color.a *= f;
  }
  vColor = color;

  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float featherDepth;
uniform sampler2D sceneDepth;
uniform vec2 depthResolution;
uniform vec2 nearFar;
uniform float softEnabled;

varying vec2 vUv;
varying vec4 vColor;
varying float vViewDepth;

// zfeather's other half: fade where the sheet nears what is behind it, by
// sat((sceneDepth - particleDepth) / featherDepth). Behind a wall it is 0, so a
// sheet crossing the world melts into it rather than cutting a line.
float softness() {
  if (softEnabled < 0.5 || featherDepth <= 0.0) return 1.0;
  float d = texture2D(sceneDepth, gl_FragCoord.xy / depthResolution).x * 2.0 - 1.0;
  float scene = 2.0 * nearFar.x * nearFar.y / (nearFar.y + nearFar.x - d * (nearFar.y - nearFar.x));
  return clamp((scene - vViewDepth) / featherDepth, 0.0, 1.0);
}

void main() {
  vec4 texel = texture2D(map, vUv);
#if defined(OUTPUT_ALPHA) || defined(OUTPUT_LUMA)
  // T5's additive sets multiply colour by alpha in the shader and blend one/one.
  // The game does it in display space, so the colour is encoded first and the
  // output transfer skipped: encoding a product is not the product of encodings.
  vec3 rgb = linearToOutputTexel(vec4(texel.rgb * vColor.rgb, 1.0)).rgb;
  float a = texel.a * vColor.a * softness();
  #ifdef OUTPUT_LUMA
    a *= dot(rgb, vec3(0.25, 0.5, 0.25));
  #endif
  gl_FragColor = vec4(rgb * a, a);
#else
  float soft = softness();
  gl_FragColor = texel * vColor;
  gl_FragColor.a *= soft;
  // The materials' alpha test is gt0: only a fully transparent texel is dropped.
  if (gl_FragColor.a <= 0.0) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef SOFT_RGB
    // A blend that ignores source alpha (one/one, invdestcolor/one) fades by its colour.
    gl_FragColor.rgb *= soft;
  #endif
#endif

#ifdef FOG_FADE
  // An additive sheet fades to nothing in fog, rather than adding fog colour.
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor *= 1.0 - fogFactor;
  #endif
#else
  #include <fog_fragment>
#endif
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
  output?: "straight" | "alpha" | "luma";
  fogFade?: boolean;
  falloff?: { scale: number; bias: number; begin: readonly number[]; end: readonly number[] };
  /** Metres; 0 or absent for none. */
  eyeOffset?: number;
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
        sceneDepth: { value: null },
        depthResolution: { value: new THREE.Vector2(1, 1) },
        nearFar: { value: new THREE.Vector2(0.1, 200) },
        softEnabled: { value: 0 },
        eyeOffset: { value: opts.eyeOffset ?? 0 },
        falloff: { value: new THREE.Vector3(opts.falloff?.scale ?? 0, opts.falloff?.bias ?? 0, opts.falloff ? 1 : 0) },
        falloffBegin: { value: new THREE.Vector3(...(opts.falloff?.begin ?? [1, 1, 1]).slice(0, 3)) },
        falloffEnd: { value: new THREE.Vector3(...(opts.falloff?.end ?? [1, 1, 1]).slice(0, 3)) },
      },
    ]),
    defines: {
      ...(opts.output === "alpha" ? { OUTPUT_ALPHA: "" } : {}),
      ...(opts.output === "luma" ? { OUTPUT_LUMA: "" } : {}),
      ...(opts.fogFade ? { FOG_FADE: "" } : {}),
      ...(opts.blendSrc !== "srcalpha" && opts.blendDst === "one" ? { SOFT_RGB: "" } : {}),
    },
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
  private readonly attrs: Record<"pos" | "size" | "rot" | "color" | "frame" | "mode" | "shape" | "axisA" | "axisB", THREE.InstancedBufferAttribute>;
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
      shape: attr("iShape", 4),
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
    const { pos, size, rot, color, frame, mode, shape, axisA, axisB } = this.attrs;
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
    shape.array[i * 4] = v.trimTop;
    shape.array[i * 4 + 1] = v.trimBottom;
    shape.array[i * 4 + 2] = v.pivotX;
    shape.array[i * 4 + 3] = v.pivotY;
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

  /** Whether this batch's material fades where it meets the world (a zfeather sheet). */
  get feathered(): boolean {
    return (this.material.uniforms.featherDepth!.value as number) > 0;
  }

  /** Point the soft-particle fade at this frame's scene depth. */
  useDepth(depth: { texture: THREE.Texture; resolution: THREE.Vector2; nearFar: THREE.Vector2 }): void {
    const u = this.material.uniforms;
    u.sceneDepth!.value = depth.texture;
    (u.depthResolution!.value as THREE.Vector2).copy(depth.resolution);
    (u.nearFar!.value as THREE.Vector2).copy(depth.nearFar);
    u.softEnabled!.value = 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
