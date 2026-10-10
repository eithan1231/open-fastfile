// The world mounted now, as everything that outlives it reads it. Written only
// by the WorldLoader; read by whatever needs this world's root, resolved data or
// assets at the moment it asks, rather than a copy taken when it was built.

import type * as THREE from "three";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { AssetStore } from "../scene/assets.js";
import type { WorldSession } from "./WorldSession.js";

export class CurrentWorld {
  session: WorldSession | undefined;

  get slug(): string | undefined {
    return this.session?.slug;
  }

  /** The built scene, once a mount has built it. */
  get root(): THREE.Group | undefined {
    return this.session?.root;
  }

  /** The resolved world, once a mount has finished. */
  get world(): ResolvedWorld | undefined {
    return this.session?.world;
  }

  get assets(): AssetStore | undefined {
    return this.session?.assets;
  }
}
