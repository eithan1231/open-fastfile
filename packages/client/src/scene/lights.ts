// `light` nodes → three.js lights, and the photometric scales that make the
// DSL's unitless `intensity:` mean the same thing for each type.

import * as THREE from "three";
import type { ResolvedLight } from "@3d/shared/dsl/resolved.js";

// three measures light in photometric units (lux, candela); the DSL's
// `intensity: 1.3` means "a bit brighter than default". These scales convert,
// tuned by eye on the example worlds. Point and spot fall off with distance
// squared, so they need far more than ambient does.
export const DIRECTIONAL_SCALE = 20;
export const POINT_SPOT_SCALE = 60;
export const AMBIENT_SCALE = 18;

/**
 * The same conversion for a lightmap, which three adds to the same irradiance
 * as the ambient lights. Without it a bake contributed under 1% of the light.
 * Matched to AMBIENT_SCALE, so `lightmap-intensity: 1` is a white texel worth an
 * ambient light of intensity 1.
 */
export const LIGHTMAP_SCALE = AMBIENT_SCALE;

/** `rotate:` as a target: three aims a light at a point, not by a rotation. */
function aimTarget(light: ResolvedLight): THREE.Vector3 {
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(light.rotation.x, light.rotation.y, light.rotation.z, "XYZ"));
  return forward.add(new THREE.Vector3(light.position.x, light.position.y, light.position.z));
}

export function buildLight(light: ResolvedLight): THREE.Object3D {
  const color = new THREE.Color(light.color ?? "#ffffff");

  switch (light.type) {
    case "directional": {
      const directionalLight = new THREE.DirectionalLight(color, light.intensity * DIRECTIONAL_SCALE);
      directionalLight.position.set(light.position.x, light.position.y, light.position.z);

      // Unaimed, a sun shines at the world origin: what every imported map assumes.
      if (light.aimed) {
        directionalLight.target.position.copy(aimTarget(light));
      } else {
        directionalLight.target.position.set(0, 0, 0);
      }

      // Frustum and bias are fitted at runtime (engine/shadows.ts); map size is a quality setting.
      if (light.shadows) {
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.set(2048, 2048);
      }

      const group = new THREE.Group();
      group.add(directionalLight, directionalLight.target);

      return group;
    }

    case "point": {
      const pointLight = new THREE.PointLight(color, light.intensity * POINT_SPOT_SCALE, 0, 2);
      pointLight.position.set(light.position.x, light.position.y, light.position.z);

      if (light.shadows) {
        pointLight.castShadow = true;
        pointLight.shadow.mapSize.set(1024, 1024);
      }

      return pointLight;
    }

    case "spot": {
      const spotLight = new THREE.SpotLight(color, light.intensity * POINT_SPOT_SCALE, 0, Math.PI / 6, 0.3, 2);
      spotLight.position.set(light.position.x, light.position.y, light.position.z);

      // Down means below the light: a y = 0 target points a basement light back up.
      if (light.aimed) {
        spotLight.target.position.copy(aimTarget(light));
      } else {
        spotLight.target.position.set(light.position.x, light.position.y - 1, light.position.z);
      }

      if (light.shadows) {
        spotLight.castShadow = true;
        spotLight.shadow.mapSize.set(1024, 1024);
      }

      const group = new THREE.Group();
      group.add(spotLight, spotLight.target);
      return group;
    }

    case "ambient":
    default: {
      const ambientLight = new THREE.AmbientLight(color, light.intensity * AMBIENT_SCALE);
      return ambientLight;
    }
  }
}
