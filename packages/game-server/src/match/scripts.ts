// The gametype's scripts, as a match asks them: every hook through `each` or
// `first`, each script handed its own context with its own `memory`.
//
// The contexts are built once, after `init`, and read the match live (context.ts),
// so asking a hook costs a call and nothing else — however often a tick asks.

import type { ServerContext } from "@3d/shared/game/context.js";
import type { ClientHooks, Script, ServerHooks } from "@3d/shared/game/hooks.js";

/** An answer is any value but these: what a hook returns when it has no opinion. */
type NoOpinion = undefined | null | void | false;

export class ScriptHost {
  /** Each server script beside the context it is handed: its own where it has `init`, else the shared one. */
  private asked: { hooks: ServerHooks; ctx: ServerContext }[] = [];
  private begun = false;

  constructor(readonly list: readonly Script[]) {}

  /**
   * Run every `init` and build the contexts the hooks are handed. `context`
   * makes one around a script's memory. Before any other hook, so the first
   * `combatRules` already has its state.
   */
  start(context: (memory: unknown) => ServerContext): void {
    // `ctx.memory` is undefined while `init` runs.
    const shared = context(undefined);
    this.asked = [];
    for (const script of this.list) {
      const hooks = script.server;
      if (!hooks) {
        continue;
      }
      // A context per script with state, so a script that keeps one never reads
      // another's memory; the shared one for the rest, which is most of them.
      this.asked.push({ hooks, ctx: hooks.init ? context(hooks.init(shared)) : shared });
    }
  }

  /** True once, on the first call: whether `matchStart` is still to be asked. */
  begin(): boolean {
    if (this.begun) {
      return false;
    }
    this.begun = true;
    return true;
  }

  /** Ask every script, in `SCRIPTS` order. */
  each(ask: (hooks: ServerHooks, ctx: ServerContext) => void): void {
    for (const { hooks, ctx } of this.asked) {
      ask(hooks, ctx);
    }
  }

  /** The first script with an opinion wins; undefined where none has one. */
  first<T>(ask: (hooks: ServerHooks, ctx: ServerContext) => T | NoOpinion): T | undefined {
    for (const { hooks, ctx } of this.asked) {
      const said = ask(hooks, ctx);
      if (said) {
        return said;
      }
    }
    return undefined;
  }

  /** `first`, over the hooks both ends run. They are handed a view, not a context, so they take no memory. */
  firstClient<T>(ask: (hooks: ClientHooks) => T | NoOpinion): T | undefined {
    for (const script of this.list) {
      const said = script.client && ask(script.client);
      if (said) {
        return said;
      }
    }
    return undefined;
  }
}
