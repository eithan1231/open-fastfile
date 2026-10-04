// What this process calls itself.
//
// Random per process on purpose: a restarted instance is a new entry in the
// registry, and the old one expires on its own rather than being adopted by a
// server that has forgotten every game it was hosting.

import { randomUUID } from "node:crypto";
import { singleton } from "tsyringe";

@singleton()
export class Identity {
  readonly id = `gs-${randomUUID().slice(0, 8)}`;
}
