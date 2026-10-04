// @vitest-environment happy-dom
//
// Gameplay input: keys become named actions, scoped to where they make sense.

import { afterEach, describe, expect, it, vi } from "vitest";
import { InputManager } from "../src/input/InputManager.js";
import { keyLabel } from "../src/input/bindings.js";

let input: InputManager | undefined;

let canvas: HTMLCanvasElement;

function setup(): InputManager {
  canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  input = new InputManager(canvas);
  return input;
}

/**
 * One frame's mouse movement. `pointermove` rather than `mousemove` because the
 * manager listens for the coalesced one; happy-dom has no PointerEvent, and the
 * two fields the handler reads are all it needs.
 */
function look(x: number, y: number): void {
  const event = new Event("pointermove") as Event & { movementX: number; movementY: number };
  event.movementX = x;
  event.movementY = y;
  document.dispatchEvent(event);
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

/** Pretend the canvas holds (or has lost) the pointer lock. */
function lock(locked: boolean): void {
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => (locked ? canvas : null) });
  document.dispatchEvent(new Event("pointerlockchange"));
}

afterEach(() => {
  lock(false);
  input?.dispose();
  input = undefined;
  document.body.innerHTML = "";
});

describe("InputManager", () => {
  it("fires world actions only while a world is up", () => {
    const im = setup();
    const toggle = vi.fn();
    im.on("toggleView", toggle);
    key("keydown", "Tab");
    expect(toggle).not.toHaveBeenCalled();
    im.context = "world";
    const e = key("keydown", "Tab");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true); // Tab must not move focus
  });

  it("fires `always` actions in the menu too", () => {
    const im = setup();
    const quality = vi.fn();
    im.on("quality", quality);
    key("keydown", "KeyQ");
    expect(quality).toHaveBeenCalledTimes(1);
  });

  it("ignores key repeats for toggles but counts them for jump", () => {
    const im = setup();
    im.context = "world";
    lock(true);
    const toggle = vi.fn();
    im.on("colliders", toggle);
    key("keydown", "KeyC");
    key("keydown", "KeyC", { repeat: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    key("keydown", "Space");
    expect(im.takePressed("jump")).toBe(true);
    expect(im.takePressed("jump")).toBe(false); // consumed
    key("keydown", "Space", { repeat: true });
    expect(im.takePressed("jump")).toBe(true); // holding Space hops
  });

  it("only moves while the pointer is locked", () => {
    const im = setup();
    im.context = "world";
    key("keydown", "KeyW");
    expect(im.isHeld("forward")).toBe(false);
    lock(true);
    key("keydown", "KeyW");
    expect(im.isHeld("forward")).toBe(true);
    key("keyup", "KeyW");
    expect(im.isHeld("forward")).toBe(false);
  });

  it("drops every held key when the pointer lock or the window focus goes", () => {
    const im = setup();
    im.context = "world";
    lock(true);
    key("keydown", "KeyD");
    lock(false);
    expect(im.isHeld("right")).toBe(false);
    lock(true);
    key("keydown", "KeyD");
    window.dispatchEvent(new Event("blur"));
    expect(im.isHeld("right")).toBe(false);
  });

  it("accumulates mouse look only while locked", () => {
    const im = setup();
    im.context = "world";
    look(5, 2);
    expect(im.takeLook()).toEqual({ x: 0, y: 0 });
    lock(true);
    look(5, 2);
    look(1, -1);
    expect(im.takeLook()).toEqual({ x: 6, y: 1 });
    expect(im.takeLook()).toEqual({ x: 0, y: 0 });
  });

  it("leaves modified keys and typing in a field alone", () => {
    const im = setup();
    im.context = "world";
    const colliders = vi.fn();
    im.on("colliders", colliders);
    const copy = key("keydown", "KeyC", { ctrlKey: true });
    expect(copy.defaultPrevented).toBe(false);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", bubbles: true, cancelable: true }));
    expect(colliders).not.toHaveBeenCalled();
  });

  it("takes mouse buttons only with the pointer locked: the click that locks it is not a shot", () => {
    const im = setup();
    im.context = "world";
    document.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    expect(im.isHeld("fire")).toBe(false);
    lock(true);
    document.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    document.dispatchEvent(new MouseEvent("mousedown", { button: 2 }));
    expect(im.isHeld("fire")).toBe(true);
    expect(im.isHeld("ads")).toBe(true);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(im.isHeld("fire")).toBe(false);
    const menu = new MouseEvent("contextmenu", { cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true); // the right button aims
  });

  it("stops handlers after unsubscribing", () => {
    const im = setup();
    const quality = vi.fn();
    const off = im.on("quality", quality);
    off();
    key("keydown", "KeyQ");
    expect(quality).not.toHaveBeenCalled();
  });
});

describe("keyLabel", () => {
  it("names keys for a controls screen", () => {
    expect(keyLabel("KeyW")).toBe("W");
    expect(keyLabel("ArrowUp")).toBe("Up arrow");
    expect(keyLabel("Backquote")).toBe("`");
    expect(keyLabel("ShiftLeft")).toBe("Shift");
    expect(keyLabel("Mouse0")).toBe("Left mouse");
    expect(keyLabel("Mouse2")).toBe("Right mouse");
  });
});
