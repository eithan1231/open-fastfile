// What a match is playing: handed to `Match` by `Games`, or by a test.

import type { CatalogueView } from "@3d/shared/game/catalogueView.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { Bounds } from "@3d/shared/game/volumes.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { Presence } from "@3d/shared/worlds/presence.js";
import type { BodyView } from "../bodies.js";
import type { NavSource } from "./nav.js";

/** The map, the rules, and the catalogue a match's cast comes from. */
export interface Playing {
  /** The world's slug, which is what a gametype's `maps` restriction names. */
  map: string;
  gametype: GametypeDecl;
  catalogue: CatalogueView;
  /** The rigs a shot is traced against, for the bodies that catalogue dresses players in. */
  bodies: BodyView;
  /**
   * The scripts this match runs. Absent means the registry's answer for this
   * gametype and map, which is what a real game gets.
   *
   * Here for the reason a `CapsuleWorld` and a `BodyView` are constructor
   * arguments rather than things a match builds: a test that wants to watch a
   * hook fire has nowhere else to put one, since `SCRIPTS` is a compiled-in table
   * and there is nothing to register with. Nothing in the server passes it.
   */
  scripts?: readonly Script[];
  /**
   * The world's navigation, shared by every game on the map (worlds.ts). Its
   * graph is null until baked, and bots stand still until it is not. Absent for
   * a world with none, where they stand still for good.
   */
  nav?: NavSource;
  /**
   * What an actor collides with: the same presence on the `ai` channel
   * (`CollisionWorld.view(presence, "ai")`). Absent: the players' collision.
   */
  actorCollision?: CapsuleWorld;
  /**
   * Which of the world's solids are present, live. The same object the match's
   * collision view reads (`CollisionWorld.view`), so `Games` hands in both.
   * Absent: seeded from the gametype's mode, for a test with no parts.
   */
  presence?: Presence;
  /** One part alone (`CollisionWorld.partView`), for a restore's overlap check. */
  partView?: (index: number) => CapsuleWorld;
  /** A part's bounds (`CollisionWorld.partBounds`): where a solid with `use` is. Absent: no solid is usable. */
  partBounds?: (index: number) => Bounds | undefined;
}
