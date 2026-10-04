// The client half of the scripting layer: what a browser does when the server
// says a gametype announced something.
//
// It is one seam and deliberately a narrow one. `ClientContext` is the whole
// vocabulary a client script has — reads, `say`, and a `request` that is not
// built — so this file is the only place in the browser where a script is handed
// anything at all, and the only thing it is handed that *does* something is a
// sound at the listener. There is no position to give it: a script may say
// something out loud, and it may not make a noise somewhere
// (@3d/shared/game/announcement.ts).
//
// It lives in `app/` because it wires two layers together — `net/` delivers the
// event and `engine/audio/` plays the sound — and neither of those may know
// about the other.

import type { AnnounceEvent } from "@3d/shared/net/messages/events.js";
import type { FeedbackChannel, FeedbackOptions } from "@3d/shared/game/announcement.js";
import type { ClientContext, GameView, PlayerView } from "@3d/shared/game/context.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { UsableThing } from "@3d/shared/game/focus.js";
import { scriptsFor } from "@3d/shared/game/registry.js";
import type { Channel } from "../engine/audio/mixer.js";
import type { AudioSystem } from "../engine/audio/system.js";

/**
 * A script's two channels as the mixer's, which is also the check that they are
 * two of them.
 *
 * `FeedbackChannel` is declared in `@3d/shared`, which cannot see the mixer, so
 * without this a renamed channel would be a sound nobody hears rather than a
 * build failure. `satisfies` makes it one in both directions: a channel added
 * there and not here does not compile either.
 */
const FEEDBACK_CHANNELS = { ui: "ui", voice: "voice" } as const satisfies Record<FeedbackChannel, Channel>;

/** What a client script says when it says nothing: an announcement is a voice line unless it is a blip. */
const DEFAULT_CHANNEL: FeedbackChannel = "voice";

/** Where the scripts are run, as this browser currently stands. Rebuilt per announcement, never held. */
export interface ScriptSurroundings {
  /** The world, the gametype, the catalogue and the clock — the same shape a game server builds. */
  view: GameView;
  /** Which of `view.players` this browser is, so a script can tell "ours" from "theirs". */
  self: PlayerView | undefined;
}

export class ClientScripts {
  /**
   * Aliases already complained about.
   *
   * Once each, and never silence on its own: a script naming something no bank
   * here holds is a build that will never make that sound, and it would otherwise
   * look exactly like a script that chose not to. `pnpm catalog` is the half of
   * this that fails before anybody plays; this is the half that keeps playing.
   */
  private readonly unknown = new Set<string>();

  constructor(
    private readonly audio: AudioSystem,
    /**
     * The scripts to ask. Absent means the registry's answer for whatever
     * gametype and map the view names, which is what a real game gets.
     *
     * Here for the reason `Playing.scripts` is on the server: `SCRIPTS` is a
     * compiled-in table and there is nothing to register with, so a test that
     * wants to watch a hook fire has nowhere else to put one.
     */
    private readonly scripts?: readonly Script[],
  ) {}

  /**
   * One announcement, to every script this gametype and map run.
   *
   * Every client hears every announcement — the localising is a read against
   * `self`, not an address the server had to work out — so a script that does not
   * recognise `what` simply returns, and two scripts that both do both speak.
   */
  hear(event: AnnounceEvent, where: ScriptSurroundings): void {
    const { view } = where;
    const ctx = this.context(where);
    // The side is an index on the wire and a name in a script, exactly as
    // `PlayerState.team` is: both ends hold the declaration that resolves it.
    const team = event.team === null ? undefined : view.gametype.teams[event.team];
    const announcement = { what: event.what, team, value: event.value ?? undefined, player: event.player ?? undefined };
    for (const script of this.running(view)) {
      script.client?.event?.(ctx, announcement);
    }
  }

  /**
   * What the prompt says while `thing` is in focus: the first script with an
   * opinion, null for "show nothing", undefined when none has one.
   */
  prompt(thing: UsableThing, where: ScriptSurroundings): string | null | undefined {
    const ctx = this.context(where);
    for (const script of this.running(where.view)) {
      const said = script.client?.prompt?.(ctx, thing);
      if (said !== undefined) {
        return said;
      }
    }
    return undefined;
  }

  /** The scripts this view's gametype and map run: the ones every hook here asks, and `usable` too. */
  running(view: GameView): readonly Script[] {
    return this.scripts ?? scriptsFor(view.gametype.id, view.map);
  }

  private context(where: ScriptSurroundings): ClientContext {
    return {
      ...where.view,
      self: where.self,
      say: (alias, options) => this.say(alias, options),
      // The rule `ServerContext.send` follows: a verb that is declared and not
      // built throws, so a script that tries it fails loudly rather than
      // believing it was heard.
      request: (): never => {
        throw new Error("a client script called request(), which is declared but not built");
      },
    };
  }

  /**
   * What `ClientContext.say` does: flat, on a feedback channel, at the listener.
   *
   * `playAtListener` and never `playAt`, which is what makes the narrowness real
   * rather than a convention — there is nowhere for a caller to put a position,
   * so no script can pan anything, attenuate anything or imply a direction.
   */
  private say(alias: string, options?: FeedbackOptions): void {
    if (!this.audio.knows(alias)) {
      if (!this.unknown.has(alias)) {
        this.unknown.add(alias);
        console.warn(`[script] said "${alias}", which no sound bank loaded here holds; it will be silent`);
      }
      return;
    }
    this.audio.playAtListener(alias, { channel: FEEDBACK_CHANNELS[options?.channel ?? DEFAULT_CHANNEL], volume: options?.volume });
  }
}
