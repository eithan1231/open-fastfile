// A material's shader changes, composed.
//
// three gives a material one `onBeforeCompile` and one `customProgramCacheKey`,
// so two features that each assigned their own kept only the last: layers and
// flag wind on one material lost the layers. Every per-material change goes
// through here instead, as a named patch; a material runs its patches in the
// order they were added, and its program key is all of theirs. Changes that
// apply to every shader are chunks (render/chunks.ts), not patches.

import type * as THREE from "three";

export interface ShaderPatch {
  /** Which feature this is. Adding a patch of the same name replaces the earlier one. */
  readonly name: string;
  /** Everything that changes the GLSL this patch writes: materials with equal keys share a program. */
  readonly key: string;
  apply(shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer): void;
}

// Not `userData`: `Material.copy` deep-copies that through JSON, which a function does not survive.
const patchesOf = new WeakMap<THREE.Material, ShaderPatch[]>();

/** Add `patch` to `material`, after any it already has, and recompile it. */
export function addPatch(material: THREE.Material, patch: ShaderPatch): void {
  const list = (patchesOf.get(material) ?? []).filter((p) => p.name !== patch.name);
  list.push(patch);
  install(material, list);
}

export function hasPatch(material: THREE.Material, name: string): boolean {
  return patchesOf.get(material)?.some((p) => p.name === name) ?? false;
}

function install(material: THREE.Material, list: ShaderPatch[]): void {
  patchesOf.set(material, list);
  const key = list.map((p) => p.key).join("|");
  material.onBeforeCompile = (shader, renderer) => {
    for (const patch of list) {
      patch.apply(shader, renderer);
    }
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}
