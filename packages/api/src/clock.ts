// What time it is, as a dependency rather than a call to Date.now().
//
// Injected for one reason and it is a good one: a thirty-second countdown, a
// session that expires in a month and a registry entry that goes stale in thirty
// seconds are all testable in a few lines, and none of the services that read a
// clock has to take a `now` parameter to make that possible. A test registers
// its own Clock on a child container and every one of them sees it.

import { singleton } from "tsyringe";

@singleton()
export class Clock {
  /** Unix milliseconds. */
  now(): number {
    return Date.now();
  }

  /** Unix seconds, which is what every column in db/schema.ts stores. */
  seconds(): number {
    return Math.floor(this.now() / 1000);
  }
}
