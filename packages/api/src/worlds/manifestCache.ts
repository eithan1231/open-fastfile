// The worlds manifest, rebuilt no more often than it needs to be.
//
// Building it parses every world's `world { }` header with the real parser — 52
// worlds today, tens of milliseconds — which is far too much to redo per request
// and cheap enough to redo on a timer. A boot-time build that never expired was
// the previous behaviour, and it meant a world added to the volume never showed
// up in the menu until a restart.
//
// A TTL rather than an fs watcher on purpose: worlds/ holds an exporter's scratch
// space as well as its output, and watching it recursively exhausts inotify
// watches (tens of thousands of files per imported map).

import { inject, singleton } from "tsyringe";
import type { WorldManifestEntry } from "@3d/shared/protocol/routes/worlds.js";
import { Clock } from "../clock.js";
import { Config } from "../config.js";
import { buildManifest } from "./manifest.js";

const TTL_MS = 2000;

@singleton()
export class ManifestCache {
  private cached: Promise<WorldManifestEntry[]> | undefined;
  private builtAt = 0;

  constructor(
    @inject(Config) private readonly config: Config,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  get(): Promise<WorldManifestEntry[]> {
    if (this.cached === undefined || this.clock.now() - this.builtAt > TTL_MS) {
      this.builtAt = this.clock.now();
      // The promise itself, not its result: the menu's first load is a burst of
      // requests on a cold cache, and they then share one build rather than
      // starting one each.
      this.cached = buildManifest(this.config.worldsRoot).catch((e: unknown) => {
        // A failed build must not be cached for the TTL — the next caller tries
        // again — but the rejection is still this caller's to see.
        this.cached = undefined;
        throw e;
      });
    }
    return this.cached;
  }
}
