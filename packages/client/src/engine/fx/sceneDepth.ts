// The world's depth, as particles read it. They draw after the output pass,
// onto a canvas with no depth of the world's, so they test against the frame
// target's depth texture in the shader instead (docs/engine/rendering.md#the-frame);
// a feathered sheet reads the same value for its soft fade.

import * as THREE from "three";
import { VIEW_DEPTH_GLSL, type FrameTarget } from "../render/target.js";

/** Fragment GLSL: the uniforms, and the view-space distance to the world at this pixel. */
export const SCENE_DEPTH_GLSL = /* glsl */ `
uniform sampler2D sceneDepth;
uniform vec2 depthResolution;
uniform vec2 nearFar;
${VIEW_DEPTH_GLSL}
float sceneViewDepth() {
  return viewDepthOf(texture2D(sceneDepth, gl_FragCoord.xy / depthResolution).x, nearFar);
}
`;

export function sceneDepthUniforms(): Record<string, THREE.IUniform> {
  return {
    sceneDepth: { value: null },
    depthResolution: { value: new THREE.Vector2(1, 1) },
    nearFar: { value: new THREE.Vector2(0.1, 200) },
  };
}

/** Point a material's scene-depth uniforms at this frame's target. */
export function bindSceneDepth(uniforms: Record<string, THREE.IUniform>, target: FrameTarget): void {
  uniforms.sceneDepth!.value = target.depth;
  (uniforms.depthResolution!.value as THREE.Vector2).copy(target.resolution);
  (uniforms.nearFar!.value as THREE.Vector2).copy(target.nearFar);
}
