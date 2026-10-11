// The drain: every member's queued inputs spent, in join order. Each input is
// stepped through the same simulation its client predicted with, its shots fired
// and judged, its drift measured, and a use press found.

import type { MatchClock } from "./clock.js";
import type { Member, Roster } from "./roster.js";
import type { Shots } from "./shots.js";
import type { Interactions } from "./use.js";

export class InputDrain {
  constructor(
    private readonly clock: MatchClock,
    private readonly roster: Roster,
    private readonly use: Interactions,
    private readonly shots: Shots,
  ) {}

  run(): void {
    for (const member of this.roster.values()) {
      this.spend(member);
    }
  }

  private spend(member: Member): void {
    const { player, inputs } = member;
    for (const message of inputs.take()) {
      const pressed = inputs.spend(message);
      // A dead player is acked and not simulated: the queue must still drain or
      // it backs up for the whole countdown, but nothing moves and nothing
      // fires. A client that keeps predicting is corrected on the next
      // snapshot, which is what a death screen exists to cover.
      if (player.dead) {
        continue;
      }
      // Before the step: from where they stood when the input was made, which
      // is where the prompt they read was worked out from.
      if (pressed) {
        this.use.press(member, message.input);
      }

      // The client's own dt, not our wall clock: re-simulating the step they
      // actually took is the whole point. Clamped because it is still a claim
      // about time, and the codec's 0.25 s ceiling is far too generous to hand
      // to gravity.
      const dt = Math.min(Math.max(message.dt, 0), 2 * this.clock.dt);
      const held = player.weapon;
      const firedBefore = held?.data.fired ?? 0;
      // **Trace, then kick.** A bullet is away before the weapon recoils, so a
      // round fired on this step leaves along the aim as it stood *before* the
      // step's own impulse — the aim the player last saw. Copied, because
      // `Player.step` adds that impulse into this very object.
      const aimedWith = held ? { pitch: held.data.viewKick.pitch, yaw: held.data.viewKick.yaw } : null;
      // The cone is the same case and for the same reason: a round is placed by
      // how hot the weapon was *before* its own `fireAdd` opened it further,
      // which is also the cone the shooter was shown.
      const heldWith = held ? { spread: held.data.spread, ads: held.data.ads } : null;
      player.step(message.input, dt);
      // Per input, because this is the only scope holding both the input that
      // fired and the `drawn` naming the moment its sender was drawing: four
      // queued inputs are four different moments.
      this.shots.fire(member, held, firedBefore, aimedWith, heldWith, message);

      // Measured, and then **not** acted on: the claim is evidence about what the
      // client predicted, and our own answer is what anybody gets told. A bot has
      // no client and claims nothing; nor does an input recovered from a later
      // datagram.
      if (message.claim) {
        inputs.measure(player.movement.feet, message.claim);
      }
    }
  }
}
