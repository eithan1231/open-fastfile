// The engine's changes to three's own shader chunks: global, so every program
// compiled afterwards has them. Installed once by the Viewer (installChunks), and
// never as a side effect of importing a module. The grade is the one chunk that
// changes per world (render/grade.ts).

import * as THREE from "three";

/** The share of a ranged light's reach over which it fades out: a CoD primary light's `falloffdistance` over its radius, typically. */
export const RANGE_FADE = 0.25;

// three's cutoff window, (1 - (d/r)^4)^2, is already a third down at 80% of the
// range, so a ceiling light whose range just reaches the floor lit nothing. A
// ranged light (the only kind built with decay 0) instead keeps its strength
// and smoothsteps to nothing over the last RANGE_FADE, as T5's spot shader does.
const WINDOW = "distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );";
const RANGED = `distanceFalloff *= decayExponent == 0.0
			? 1.0 - smoothstep( cutoffDistance * ${(1 - RANGE_FADE).toFixed(2)}, cutoffDistance, lightDistance )
			: pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );`;

/** Install every chunk change. Idempotent; must run before the first material compiles. */
export function installChunks(): void {
  const lights = THREE.ShaderChunk.lights_pars_begin;
  if (lights.includes(RANGED)) {
    return;
  }
  if (!lights.includes(WINDOW)) {
    throw new Error("three's lights_pars_begin changed: ranged lights would fall off with its window");
  }
  THREE.ShaderChunk.lights_pars_begin = lights.replace(WINDOW, RANGED);
}
