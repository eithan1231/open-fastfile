// What a player asks for in one step: the command a client sends and a server
// replays. Plain, JSON-safe data. Keyboard and mouse become one of these in
// engine/controls/firstPerson.ts; everything after that reads only this.

export interface PlayerInput {
  /**
   * Where the player looks, radians (yaw about +Y, pitch up positive). Absolute
   * rather than a turn since the last step, so a lost command cannot skew the aim.
   */
  yaw: number;
  pitch: number;
  /** -1 to 1: forward positive, back negative. */
  forward: number;
  /** -1 to 1: right positive, left negative. */
  right: number;
  run: boolean;
  /** Held. A held jump jumps again on landing. */
  jump: boolean;
  /** Held: the trigger. */
  fire: boolean;
  /** Held: aiming down the sights. */
  ads: boolean;
  /** Pressed this step. */
  reload: boolean;
  /** Pressed this step: put the held weapon away and bring the other one up (sim/loadout.ts). */
  swap: boolean;
  /**
   * Held: the use key. A level and not an edge, so a lost datagram cannot eat a
   * press — the server acts on the rising edge (game/focus.ts). Nothing in the
   * simulation reads it; bots and actors never set it.
   */
  use: boolean;
}

/** Nothing held, looking at `yaw`/`pitch`. */
export function idleInput(yaw: number, pitch: number): PlayerInput {
  return { yaw, pitch, forward: 0, right: 0, run: false, jump: false, fire: false, ads: false, reload: false, swap: false, use: false };
}

/** Run held while moving forward: the one sprint rule, which movement and the weapon both read. */
export function wantsSprint(input: PlayerInput): boolean {
  return input.run && input.forward > 0;
}
