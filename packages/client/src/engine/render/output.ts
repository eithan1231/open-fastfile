// The output pass: the world frame, tone-mapped, graded and fogged once, onto
// the canvas.
//
// In the order three's own materials run those steps: tone mapping (three's,
// exposure included, with the grade as its CustomToneMapping, render/grade.ts),
// then the colour-space encode, then fog toward the fog colour in display space.
// So a fully fogged hill comes out the sky's colour, as it always did, and this
// is the one program the grade is compiled into. The sky itself is passed
// through untouched, as three draws `scene.background`: a pixel the world drew
// nothing on still holds the cleared depth of 1.

import * as THREE from "three";
import { addPatch } from "./patches.js";
import { VIEW_DEPTH_GLSL, type FrameTarget } from "./target.js";

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D frameColour;
uniform sampler2D frameDepth;
uniform vec2 nearFar;
// x: 0 no fog, 1 exponential squared (y density), 2 linear (y near, z far); three's two kinds.
uniform vec3 fogParams;
uniform vec3 fogColour;
varying vec2 vUv;
${VIEW_DEPTH_GLSL}
void main() {
  float stored = texture2D(frameDepth, vUv).x;
  bool sky = stored >= 1.0;
  gl_FragColor = vec4(texture2D(frameColour, vUv).rgb, 1.0);
  if (!sky) {
    #include <tonemapping_fragment>
  }
  #include <colorspace_fragment>
  if (!sky && fogParams.x > 0.5) {
    float z = viewDepthOf(stored, nearFar);
    float fog = fogParams.x < 1.5 ? 1.0 - exp(-fogParams.y * fogParams.y * z * z) : smoothstep(fogParams.y, fogParams.z, z);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColour, fog);
  }
}
`;

export class OutputPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      frameColour: { value: null },
      frameDepth: { value: null },
      nearFar: { value: new THREE.Vector2(0.1, 200) },
      fogParams: { value: new THREE.Vector3() },
      fogColour: { value: new THREE.Color() },
    },
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    this.scene.matrixWorldAutoUpdate = false;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.setGrade("none");
  }

  /**
   * Recompile for a new grade. three keys a program by its parameters, not by the
   * chunk text the grade rewrites, so the grade's own key has to be part of it.
   */
  setGrade(key: string): void {
    addPatch(this.material, { name: "grade", key: `grade:${key}`, apply: () => {} });
  }

  render(renderer: THREE.WebGLRenderer, target: FrameTarget, fog: THREE.Fog | THREE.FogExp2 | null): void {
    const u = this.material.uniforms;
    u.frameColour!.value = target.colour;
    u.frameDepth!.value = target.depth;
    (u.nearFar!.value as THREE.Vector2).copy(target.nearFar);
    const params = u.fogParams!.value as THREE.Vector3;
    if (fog instanceof THREE.FogExp2) {
      params.set(1, fog.density, 0);
    } else if (fog) {
      params.set(2, fog.near, fog.far);
    } else {
      params.set(0, 0, 0);
    }
    // In the encoded space it is mixed in, as three hands its own materials the fog colour.
    fog?.color.getRGB(u.fogColour!.value as THREE.Color, renderer.outputColorSpace);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  async prewarm(renderer: THREE.WebGLRenderer): Promise<void> {
    renderer.setRenderTarget(null);
    await renderer.compileAsync(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}
