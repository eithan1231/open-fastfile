// Who is waiting for a game.
//
// In memory and in arrival order, so that the player who has been waiting
// longest is the one placed first. A user is in the queue or in a lobby, never
// both: the matchmaker takes them out of here the moment it puts them in one.

import { singleton } from "tsyringe";

export interface Waiting {
  readonly userId: string;
  readonly username: string;
  /** When they started looking — what the `searching` event reports. */
  readonly since: number;
  /** When they were last known to be connected. See the matchmaker's presence sweep. */
  seenAt: number;
}

@singleton()
export class Queue {
  private readonly entries = new Map<string, Waiting>();

  add(user: { id: string; username: string }, now: number): void {
    if (!this.entries.has(user.id)) {
      this.entries.set(user.id, { userId: user.id, username: user.username, since: now, seenAt: now });
    }
  }

  remove(userId: string): void {
    this.entries.delete(userId);
  }

  /** They are still there. */
  touch(userId: string, now: number): void {
    const entry = this.entries.get(userId);
    if (entry) {
      entry.seenAt = now;
    }
  }

  since(userId: string): number | undefined {
    return this.entries.get(userId)?.since;
  }

  /** Oldest first. A copy, so the caller may place players while iterating. */
  waiting(): Waiting[] {
    return [...this.entries.values()];
  }
}
