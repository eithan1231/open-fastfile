// What one tick of a match does, as named phases in a fixed order. A step a
// match needs fills a slot here rather than a line in `Match.step`, so the order
// is this list and a test pins it.

/** Every phase a tick runs, in order. Where one needs another first, its comment says so. */
export const PHASES = [
  // Last tick's shots and announcements are cleared, and the outbox's retention
  // expires — by the clock, once, rather than once per player who was sent it.
  "records",
  // The world's graph, if its bake finished since the last tick: before anything
  // plans on it or a script asks whether it is ready.
  "nav",
  // Once, on the first tick, whether or not anybody is here yet: a gametype's
  // bots are added here, so they are on the map before the first player. Before
  // the bots think, so the ones it adds think this tick.
  "start",
  // Before the drain, so a bot's input for this tick is spent in it, like a
  // client's that arrived in time.
  "bots",
  // Every member's queued inputs, in join order: each is stepped, its shots fired
  // and judged, its drift measured, and a use press found.
  "inputs",
  // After every input is spent, so a hook that changes the world does so between
  // players' steps rather than in the middle of one.
  "interactions",
  // After the inputs that carried anybody over the edge, and before health, so
  // their countdown starts on this tick like any other death's.
  "fall out",
  // After the players have moved and before health, so a blow that kills starts
  // its victim's countdown on this tick. Brains see the players where this
  // tick's inputs left them.
  "actors",
  // After the shots, so a player killed this tick starts their countdown on it
  // rather than a tick late, and before the history, which records the state a
  // snapshot carries.
  "health",
  // After health, so a player who died this tick leaves what they were in on it,
  // and before the scripts' tick, so a gametype's clock reads where everyone is.
  "occupancy",
  // After health, so a gametype's own clock sees this tick's deaths and respawns
  // rather than last tick's — and before physics, so a player a script kills here
  // leaves their body on the same tick as every other death.
  "scripts",
  // Exactly once per tick, whatever happened above: the step count is what every
  // end has to agree on. After health, so anything a death spawned exists first.
  "physics",
  // After the physics step, so the tick that stepped with a part is the tick it
  // leaves on, on every end (`SnapshotPresence.since`); the next tick's movement
  // and shots see the change.
  "parts",
  // After everything that moves a player, so a slot holds the state at the *end*
  // of its tick — which is what a client drew, since a snapshot carries exactly this.
  "history",
  // Last: what every snapshot of this tick carries about the actors.
  "snapshot",
] as const;

export type PhaseName = (typeof PHASES)[number];

export class TickPhases {
  private readonly phases = new Map<PhaseName, () => void>();

  /** Fill the slot `name` with `phase`, replacing what was there. */
  use(name: PhaseName, phase: () => void): void {
    this.phases.set(name, phase);
  }

  /** The names filled, in the order they run. */
  get order(): PhaseName[] {
    return PHASES.filter((name) => this.phases.has(name));
  }

  run(): void {
    for (const name of PHASES) {
      this.phases.get(name)?.();
    }
  }
}
