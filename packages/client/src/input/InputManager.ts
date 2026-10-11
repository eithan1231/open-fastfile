// Gameplay input: keyboard, mouse and pointer lock, turned into named actions
// (see bindings.ts). The only module that listens for gameplay keys; UI
// widgets handle their own clicks and typing, and nothing here touches them.

import { DEFAULT_BINDINGS, type Action, type ActionScope, type Bindings } from "./bindings.js";

/** "menu": no world is up; "world": one is. */
export type InputContext = "menu" | "world";

type PressHandler = () => void;

export class InputManager {
  /** Set by the app as it moves between menus and a world. */
  private ctx: InputContext = "menu";

  private readonly byKey = new Map<string, Action>();
  private readonly held = new Set<Action>();
  private readonly pressCounts = new Map<Action, number>();
  private readonly handlers = new Map<Action, Set<PressHandler>>();
  private readonly lockHandlers = new Set<(locked: boolean) => void>();
  private lookX = 0;
  private lookY = 0;
  /** What `takeLook` hands back, refilled in place. */
  private readonly look = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLElement,
    private readonly bindings: Bindings = DEFAULT_BINDINGS,
  ) {
    for (const [action, binding] of Object.entries(bindings) as [Action, Bindings[Action]][]) {
      for (const key of binding.keys) {
        this.byKey.set(key, action);
      }
    }
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.release);
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("pointerlockchange", this.handleLockChange);
  }

  get context(): InputContext {
    return this.ctx;
  }

  set context(ctx: InputContext) {
    if (ctx === this.ctx) {
      return;
    }
    this.ctx = ctx;
    this.release();
    if (ctx === "menu") {
      this.exitPointerLock();
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /**
   * Lock the pointer to the canvas; resolves whether it locked. Browsers refuse
   * without a click or key press (Esc does not count), except shortly after the
   * page itself released the lock.
   *
   * **Asked for unadjusted, which is what an aim wants.** Without it the browser
   * reports movement from the *accelerated system cursor*: the OS applies its
   * pointer ballistics curve, per report, and hands over the difference in
   * whole cursor pixels. That curve is a function of how far the mouse moved in
   * one report, so the same hand movement produces a different angle at a
   * different polling rate — and above about 1000 Hz each report is a fraction
   * of a pixel, which the cursor path cannot carry and delivers in lumps.
   * `unadjustedMovement` takes the deltas off the device instead, which is both
   * what fixes that and what a player expects from an aim: no acceleration.
   */
  requestPointerLock(): Promise<boolean> {
    if (this.locked) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const done = () => {
        document.removeEventListener("pointerlockchange", done);
        document.removeEventListener("pointerlockerror", done);
        resolve(this.locked);
      };
      document.addEventListener("pointerlockchange", done);
      document.addEventListener("pointerlockerror", done);
      const refused = (e: unknown) => {
        console.info(`[input] pointer lock refused: ${e instanceof Error ? e.message : "no reason given"}`);
        done();
      };
      // Unadjusted first, plain second. A browser without raw input rejects the
      // option with `NotSupportedError` rather than ignoring it, and that is a
      // refusal of the *option*, not of the lock — so it is worth asking again
      // without it. Any other rejection is a real refusal and is reported.
      const plain = (): void => {
        try {
          // A promise in current browsers, undefined in older ones; either may refuse.
          void Promise.resolve(this.canvas.requestPointerLock()).catch(refused);
        } catch (e) {
          refused(e);
        }
      };
      try {
        const asked = this.canvas.requestPointerLock({ unadjustedMovement: true });
        if (asked === undefined) {
          // Old signature: the option was ignored, and the lock is already under way.
          return;
        }
        void asked.catch((e: unknown) => {
          if (e instanceof Error && e.name === "NotSupportedError") {
            plain();
            return;
          }
          refused(e);
        });
      } catch {
        plain();
      }
    });
  }

  exitPointerLock(): void {
    if (this.locked) {
      document.exitPointerLock();
    }
  }

  /** Whether a `walk` action's key is held down right now. */
  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  /** Whether `action` was pressed (key repeats included) since the last call; clears the count. */
  takePressed(action: Action): boolean {
    const n = this.pressCounts.get(action) ?? 0;
    this.pressCounts.delete(action);
    return n > 0;
  }

  /**
   * Mouse movement since the last call, in pixels; zero unless the pointer is
   * locked. The object is reused, so read it before calling again: this runs
   * every frame of every session.
   */
  takeLook(): { x: number; y: number } {
    this.look.x = this.lookX;
    this.look.y = this.lookY;
    this.lookX = this.lookY = 0;
    return this.look;
  }

  /** Call `handler` on each press of `action` (not on key repeats) while its scope is live. Returns an unsubscribe. */
  on(action: Action, handler: PressHandler): () => void {
    let set = this.handlers.get(action);
    if (!set) {
      this.handlers.set(action, (set = new Set()));
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onLockChange(handler: (locked: boolean) => void): () => void {
    this.lockHandlers.add(handler);
    return () => this.lockHandlers.delete(handler);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.release);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    document.removeEventListener("pointerlockchange", this.handleLockChange);
    this.exitPointerLock();
  }

  private live(scope: ActionScope): boolean {
    if (scope === "always") {
      return true;
    }
    if (this.ctx !== "world") {
      return false;
    }
    return scope === "world" || this.locked;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Modified keys belong to the browser (Ctrl+C copies from a panel), and typing in a field to the UI.
    // Control pressed on its own modifies nothing: it is a key, and one a binding may name.
    const modified = (e.ctrlKey && !e.code.startsWith("Control")) || e.metaKey || e.altKey;
    if (modified || isTyping(e.target)) {
      return;
    }
    if (this.press(e.code, e.repeat)) {
      e.preventDefault();
    } // Tab must not move focus, ` must not type
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.lift(e.code);
  };

  // Buttons only count with the pointer locked: the click that locks it is not a shot, and the UI owns every other click.
  private onMouseDown = (e: MouseEvent): void => {
    if (this.locked) {
      this.press(`Mouse${e.button}`, false);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.lift(`Mouse${e.button}`);
  };

  private onContextMenu = (e: Event): void => {
    if (this.locked) {
      e.preventDefault();
    } // the right button aims
  };

  /** A key or button went down; returns whether it is bound and live. */
  private press(code: string, repeat: boolean): boolean {
    const action = this.byKey.get(code);
    if (!action) {
      return false;
    }
    const { scope } = this.bindings[action];
    if (!this.live(scope)) {
      return false;
    }
    if (scope === "walk") {
      this.held.add(action);
      this.pressCounts.set(action, (this.pressCounts.get(action) ?? 0) + 1);
    }
    if (!repeat) {
      for (const handler of this.handlers.get(action) ?? []) {
        handler();
      }
    }
    return true;
  }

  private lift(code: string): void {
    const action = this.byKey.get(code);
    if (action) {
      this.held.delete(action);
    }
  }

  /**
   * Mouse movement, taken one *frame* at a time rather than one poll at a time.
   *
   * `pointermove` is coalesced: the browser dispatches it at most once per
   * animation frame and hands over the movements it merged in
   * `getCoalescedEvents()`. `mousemove`, which this used to listen to, has no
   * such guarantee — an 8000 Hz mouse dispatches ~130 events per frame at 60 fps
   * against a 1000 Hz mouse's 16, and every one of them is a full trip through
   * the event pipeline on the main thread. The two additions below are free; the
   * dispatches are not, and when they fall behind they arrive in bursts, which
   * turns a steady hand into a view that lags and then catches up in one frame.
   *
   * A fixed-tick simulation never needs a movement per poll — it needs the sum
   * per tick, and coalescing preserves that exactly. Nothing about the feel of
   * the mouse changes; only how many times the page is interrupted to hear about
   * it.
   */
  private onPointerMove = (e: PointerEvent): void => {
    if (!this.locked) {
      return;
    }
    // The list includes this event, so it is the whole frame and `e` must not be
    // added again. Summing the parts rather than trusting `e.movementX` to equal
    // their total, because that equality is a claim about the browser and this
    // is not the place to depend on one.
    let x = 0;
    let y = 0;
    for (const part of e.getCoalescedEvents?.() ?? []) {
      x += part.movementX;
      y += part.movementY;
    }
    // Empty list, no support, or a browser that leaves movement off coalesced
    // events under pointer lock: the dispatched event still carries the frame's
    // own delta, and losing the lot would be far worse than one coarse frame.
    if (x === 0 && y === 0) {
      x = e.movementX;
      y = e.movementY;
    }
    this.lookX += x;
    this.lookY += y;
  };

  private handleLockChange = (): void => {
    const locked = this.locked;
    if (!locked) {
      this.release();
    }
    for (const handler of this.lockHandlers) {
      handler(locked);
    }
  };

  /** Forget every held key and pending press: after losing focus or the pointer, nothing may stay "down". */
  private release = (): void => {
    this.held.clear();
    this.pressCounts.clear();
    this.lookX = this.lookY = 0;
  };
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}
