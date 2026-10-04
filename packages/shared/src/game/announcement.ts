// What a gametype says out loud: the value a server script publishes, and the
// one verb a client script has for turning it into a sound.
//
// **A script says what happened, never which file.** `publish({ what:
// "flagTaken", team })` is the whole of what crosses, and the client half of
// that gametype's script decides it is `mp_enemy_obj_taken` for everybody but
// the side that took it. A server naming an alias would be a server that has to
// know what a browser shipped — which bank was built, for which game, in which
// build — and the first time those disagree it plays the wrong sound or none.
//
// It is also what makes one broadcast enough. An announcement is told to
// everybody and localised at each end against the side that end is on, so
// "enemy has the flag" and "we have the flag" are one event and not two
// addressed messages the server has to split.

import type { PlayerId } from "../net/messages/fields.js";
import type { TeamId } from "./gametypes/declaration.js";

/**
 * One thing a gametype says happened.
 *
 * Plain data, and deliberately small: `what` is a name in the gametype's own
 * vocabulary, not a sentence, and the wire carries it as a short string
 * (net/messages/events.ts). Both other fields are optional, and **absent is not
 * zero** — a countdown at 0 is a thing to say, and an announcement that belongs
 * to nobody is not one that belongs to side 0.
 */
export interface Announcement {
  /** What happened, in this gametype's vocabulary. Never an alias, never a file. */
  readonly what: string;
  /** Whose it is, by a name the gametype's `teams` lists. Absent: nobody's. */
  readonly team?: TeamId;
  /** The one number it is about — seconds left, a score, a count. An integer. */
  readonly value?: number;
  /**
   * The one player it is about — who bought a door, who was refused — read by
   * each end against its own `self`, as `team` is. Still a broadcast: everybody
   * is told, and a script decides who hears what. Absent: nobody in particular.
   */
  readonly player?: PlayerId;
}

/**
 * Where a client script's sound may go.
 *
 * Two channels and not five, because this is the verb for **saying** something
 * and not for making a noise in the world: `sfx`, `footsteps` and `ambience`
 * belong to things that are somewhere, and a script that could reach them could
 * put a footstep behind a player who is alone. It also keeps a player's mixer
 * honest — turning `voice` down silences announcements and nothing else.
 */
export type FeedbackChannel = "ui" | "voice";

/** How a client script wants what it says played. Non-positional by construction: there is no `at`. */
export interface FeedbackOptions {
  /** `ui` for a blip, `voice` for an announcement. `voice` by default. */
  channel?: FeedbackChannel;
  /** Scales the alias' own volume. */
  volume?: number;
}
