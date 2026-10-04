// Colour grading: a world's `grade` (a CoD `.vision` film tweak for imported
// maps) compiled into three's CustomToneMapping stub. No post-process pass, so
// no extra resolve and no lost MSAA; see docs/engine/rendering.md. ShaderChunk
// is global and baked in at compile time, so apply the grade before a world's
// materials are built.

import * as THREE from "three";
import type { ResolvedGrade } from "@3d/shared/dsl/resolved.js";

/** Rec. 709 luma weights — the same ones three.js uses for its own luminance helpers. */
const LUMA = "vec3( 0.2126, 0.7152, 0.0722 )";

/** The stub three.js ships, and the anchor we substitute for. Matched exactly so an upstream change fails loudly rather than silently doing nothing. */
const STUB = "vec3 CustomToneMapping( vec3 color ) { return color; }";

/** The pristine chunk, captured before anything is installed, so `apply(undefined)` can put it back. */
const PRISTINE = THREE.ShaderChunk.tonemapping_pars_fragment;

/** GLSL needs a decimal point on every float literal, and `1` would be an int. */
function f(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : "0.000000";
}

function vec3(v: { x: number; y: number; z: number }): string {
  return `vec3( ${f(v.x)}, ${f(v.y)}, ${f(v.z)} )`;
}

/**
 * The replacement `CustomToneMapping`: ACES unchanged, then a three-zone tint
 * smoothstepped either side of mid-grey (no banding at 0.5), then desaturation
 * toward the tinted colour's luminance.
 *
 * Tints are absolute multipliers (1 is neutral) and used as authored; some
 * highlight clipping is part of the look. Desaturation is authored 0..4 but
 * clamped to 1 here: past 1 a lerp overshoots into complementary colours, and
 * what the game does there is unknown. No imported map goes near it.
 */
export function gradeGlsl(grade: ResolvedGrade): string {
  return `vec3 CustomToneMapping( vec3 color ) {
	const vec3 gradeDark = ${vec3(grade.darkTint)};
	const vec3 gradeMedium = ${vec3(grade.mediumTint)};
	const vec3 gradeLight = ${vec3(grade.lightTint)};
	const vec3 gradeLuma = ${LUMA};

	color = ACESFilmicToneMapping( color );

	float gradeL = dot( color, gradeLuma );
	color *= gradeL < 0.5
		? mix( gradeDark, gradeMedium, smoothstep( 0.0, 0.5, gradeL ) )
		: mix( gradeMedium, gradeLight, smoothstep( 0.5, 1.0, gradeL ) );

	float gradeD = mix( ${f(grade.desaturationDark)}, ${f(grade.desaturation)}, smoothstep( 0.0, 0.5, gradeL ) );
	return mix( color, vec3( dot( color, gradeLuma ) ), clamp( gradeD, 0.0, 1.0 ) );
}`;
}

/**
 * Install `grade` on the renderer, or restore plain ACES when it is undefined.
 *
 * Call before building a world's materials — the values are compiled into every
 * shader, so a later change would need them all invalidated.
 */
export function applyGrade(renderer: THREE.WebGLRenderer, grade: ResolvedGrade | undefined): void {
  if (!grade) {
    THREE.ShaderChunk.tonemapping_pars_fragment = PRISTINE;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    return;
  }

  if (!PRISTINE.includes(STUB)) {
    // Upstream changed the stub's spelling. Grading silently doing nothing is
    // far worse than not grading at all, so say so and fall back.
    console.warn("[grade] three.js CustomToneMapping stub not found; colour grading disabled");
    THREE.ShaderChunk.tonemapping_pars_fragment = PRISTINE;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    return;
  }

  THREE.ShaderChunk.tonemapping_pars_fragment = PRISTINE.replace(STUB, gradeGlsl(grade));
  renderer.toneMapping = THREE.CustomToneMapping;
}
