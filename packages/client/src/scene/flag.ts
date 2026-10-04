// The game's `flag` vertex wind: cloth and grass cards that ripple along their
// normals by time alone. A port of IW4/IW5's `vs_lp_flag_*` shader; the
// disassembly and what each constant means are in docs/cod/reference.md#flag-wind.
// The exporter carries `flagParms` as material extras and vertex alpha, which
// weights the motion, as the `_FLAG_WEIGHT` attribute (scripts/cod/pack.py).

import * as THREE from "three";

/** Seconds of shader time, advanced by engine/animator.ts. One per AssetStore, shared by every flag material in it. */
export interface ShaderClock {
  value: number;
}

interface FlagParams {
  speed: number;
  offset: number;
}

function flagParamsOf(material: THREE.Material): FlagParams | undefined {
  const flag = material.userData.flag as Partial<FlagParams> | undefined;

  if (!flag || typeof flag.speed !== "number") {
    return undefined;
  }

  return {
    speed: flag.speed,
    offset: typeof flag.offset === "number" ? flag.offset : 0,
  };
}

// Three sine waves whose phase runs across the texture, summed into an offset
// in inches along the normal. The divide keeps that offset constant in world
// space whatever the placement's scale, as the game's shader does.
const FLAG_VERTEX = /* glsl */ `
{
  float flagT = ( flagTime + flagParams.y ) * flagParams.x;
  vec2 flagP = 1.0 - uv;
  float flagA = 19.5777 * flagP.x + 5.24583 * flagP.y + 7.53982 * flagT;
  float flagB = 3.62305 * flagP.x + 0.253348 * flagP.y + 5.65487 * flagT;
  float flagC = 8.25031 * flagP.x - 1.45475 * flagP.y + 9.42478 * flagT;
  float flagInches = _flag_weight * ( 1.7 * sin( flagA ) + 7.5 * sin( flagB ) + 3.0 * sin( flagC ) );
  #ifdef USE_INSTANCING
    float flagScale = length( ( modelMatrix * instanceMatrix )[ 0 ].xyz );
  #else
    float flagScale = length( modelMatrix[ 0 ].xyz );
  #endif
  transformed += normalize( objectNormal ) * ( flagInches * 0.0254 / flagScale );
}
`;

/** Make `material` ripple like the game's flag technique, driven by `clock`. */
export function applyFlagMaterial(material: THREE.Material, params: FlagParams, clock: ShaderClock): void {
  const flagParams = { value: new THREE.Vector2(params.speed, params.offset) };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.flagTime = clock;
    shader.uniforms.flagParams = flagParams;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float _flag_weight;\nuniform float flagTime;\nuniform vec2 flagParams;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FLAG_VERTEX}`);
  };

  material.customProgramCacheKey = () => "flag-wind";
  material.userData.flagWind = true;
}

/**
 * Give every material under `root` that the exporter marked as a flag its
 * wind; returns how many. Only the main pass moves: the shadow map keeps the
 * rest pose, as it does for skeletal animation (docs/engine/rendering.md).
 */
export function applyFlagWind(root: THREE.Object3D, clock: ShaderClock): number {
  let applied = 0;

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      const params = flagParamsOf(material);
      if (!params || material.userData.flagWind) {
        continue;
      }

      applyFlagMaterial(material, params, clock);
      applied++;
    }
  });

  return applied;
}
