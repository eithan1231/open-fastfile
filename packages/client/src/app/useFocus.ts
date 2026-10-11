// The use prompt: what this player would use if they pressed the use key now,
// and what the gametype's script says about it — worked out here every frame,
// from the predicted player, by the same `focusOf` a game server runs on the
// key's edge. Nothing about it crosses the wire: the server finds its own focus
// from the input, and the prompt is the client half of the script reading state
// the snapshot already carries.
//
// In `app/` because it joins the collision, the scripts and the UI, and only
// `app/` may hold all three.

import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { focusOf, usableBy, usableThings, viewerAt, type PresenceView, type UsableThing } from "@3d/shared/game/focus.js";
import type { Bounds } from "@3d/shared/game/volumes.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import type { ClientScripts, ScriptSurroundings } from "./scripts.js";
import type { UiState, UseFocusInfo } from "./uiBridge.js";

/** What a script's `prompt` says when no script says anything. */
export const DEFAULT_PROMPT = "Press {key} to use";

/** One frame's worth of what the focus is worked out from. */
export interface FocusFrame {
  /** The world mounted now, and the mode it was built for. */
  world: ResolvedWorld;
  mode: string | undefined;
  /** The collision as the match has it, and its presence: a removed part neither blocks nor is used. */
  collision: CapsuleWorld;
  presence: PresenceView;
  /** A solid's bounds, by its place in `world.solids`. */
  partBounds: (index: number) => Bounds | undefined;
  /** The predicted player: where they are, their stance, and where the last step looked. */
  movement: Readonly<MovementState>;
  /** The scripts' view of the match, built only when something is in reach. */
  where: () => ScriptSurroundings;
}

export class UseFocus {
  /** Every usable thing in the mounted world, rebuilt when the presence object (so the mount) changes. */
  private things: readonly UsableThing[] = [];
  private builtFor: PresenceView | undefined;

  constructor(
    private readonly ui: UiState,
    private readonly scripts: ClientScripts,
    /** The use key's name, as the controls help spells it. */
    private readonly key: string,
  ) {}

  /** The focus and its prompt for this frame, or null when not walking. Writes the signal only when it changes. */
  update(frame: FocusFrame | null): void {
    this.publish(frame ? this.find(frame) : null);
  }

  private find(frame: FocusFrame): UseFocusInfo | null {
    if (frame.presence !== this.builtFor) {
      this.builtFor = frame.presence;
      this.things = usableThings(frame.world, frame.mode, frame.partBounds);
    }
    if (this.things.length === 0) {
      return null;
    }
    let where: ScriptSurroundings | undefined;
    const surroundings = (): ScriptSurroundings => (where ??= frame.where());
    const viewer = viewerAt(frame.movement, frame.movement.yaw, frame.movement.pitch);
    const thing = focusOf(frame.collision, this.things, frame.presence, viewer, (t) => {
      const { view, self } = surroundings();
      // Offline there is no roster, and the player is still somebody a script can ask about.
      return usableBy(this.scripts.running(view), view, t, self ?? { id: "", bot: false, points: 0 });
    });
    if (!thing) {
      return null;
    }
    const said = this.scripts.prompt(thing, surroundings());
    return {
      text: said === undefined ? DEFAULT_PROMPT : said,
      key: this.key,
      thing: { kind: thing.kind, index: thing.index, tags: thing.tags },
    };
  }

  private publish(next: UseFocusInfo | null): void {
    const signal = this.ui.hud.use;
    const last = signal.value;
    if (
      last === next ||
      (last && next && last.text === next.text && last.key === next.key && last.thing.kind === next.thing.kind && last.thing.index === next.thing.index)
    ) {
      return;
    }
    signal.value = next;
  }
}
