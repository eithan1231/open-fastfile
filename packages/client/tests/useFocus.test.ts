// The use prompt (app/useFocus.ts): the browser works out the focus every frame
// from the predicted player, asks the gametype's client half what to say, and
// hands the HUD plain data through the UI bridge.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { GameView } from "@3d/shared/game/context.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import { createMovement, STAND_EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { Presence } from "@3d/shared/worlds/presence.js";
import type { AudioSystem } from "../src/engine/audio/system.js";
import { ClientScripts } from "../src/app/scripts.js";
import { createUiState } from "../src/app/uiBridge.js";
import { DEFAULT_PROMPT, UseFocus, type FocusFrame } from "../src/app/useFocus.js";

/** Open air: nothing in the way of any trace. */
const air = { ready: true, traceRay: () => null } as unknown as CapsuleWorld;

/** A door's buy trigger a metre ahead of the origin, at eye height. */
const world = {
  triggers: [
    { id: 1, tags: ["zone"], position: { x: 0, y: 1, z: 0 }, yaw: 0, size: { x: 4, y: 2, z: 4 } },
    { id: 2, tags: ["zombie_door"], target: "backstage", use: "near", position: { x: 0, y: STAND_EYE_HEIGHT, z: -1 }, yaw: 0, size: { x: 1, y: 1, z: 0.1 } },
  ],
  solids: [],
} as unknown as ResolvedWorld;

function setup(scripts: Script[] = []) {
  const ui = createUiState();
  const focus = new UseFocus(ui, new ClientScripts({} as AudioSystem, scripts), "F");
  const presence = new Presence(0);
  const frame = (over: Partial<FocusFrame> = {}): FocusFrame => ({
    world,
    mode: undefined,
    collision: air,
    presence,
    partBounds: () => undefined,
    movement: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
    where: () => ({ view: { gametype: { id: "test" }, map: "m" } as unknown as GameView, self: { id: "me", bot: false, points: 0 } }),
    ...over,
  });
  return { ui, focus, frame };
}

describe("the use prompt", () => {
  it("says the default with nothing to say, naming the thing and the key", () => {
    const { ui, focus, frame } = setup();
    focus.update(frame());
    expect(ui.hud.use.value).toEqual({ text: DEFAULT_PROMPT, key: "F", thing: { kind: "trigger", index: 1, tags: ["zombie_door"] } });
  });

  it("says what the script's client half says, and nothing where it says null", () => {
    const priced: Script = {
      id: "doors",
      client: { prompt: (_ctx, thing) => (thing.target === "backstage" ? "Press {key} to open the door [Cost: 1250]" : null) },
    };
    const { ui, focus, frame } = setup([priced]);
    focus.update(frame());
    expect(ui.hud.use.value?.text).toBe("Press {key} to open the door [Cost: 1250]");

    const silent: Script = { id: "quiet", client: { prompt: () => null } };
    const quiet = setup([silent]);
    quiet.focus.update(quiet.frame());
    // In focus, and nothing to show: the dev overlay can still say what it is.
    expect(quiet.ui.hud.use.value).toMatchObject({ text: null, thing: { index: 1 } });
  });

  it("clears once nothing is in reach, and while not walking", () => {
    const { ui, focus, frame } = setup();
    focus.update(frame());
    expect(ui.hud.use.value).not.toBeNull();
    focus.update(frame({ movement: createMovement({ x: 0, y: 0, z: 3 }, 0, 0) }));
    expect(ui.hud.use.value).toBeNull();
    focus.update(frame());
    focus.update(null);
    expect(ui.hud.use.value).toBeNull();
  });

  it("offers nothing the shared `usable` refuses, on the script both ends run", () => {
    const shut: Script = { id: "shut", usable: () => null };
    const { ui, focus, frame } = setup([shut]);
    focus.update(frame());
    expect(ui.hud.use.value).toBeNull();
  });

  it("writes the signal only when what it shows changes", () => {
    const { ui, focus, frame } = setup();
    focus.update(frame());
    const first = ui.hud.use.value;
    focus.update(frame({ movement: createMovement({ x: 0, y: 0, z: 0 }, 0.01, 0) }));
    expect(ui.hud.use.value).toBe(first);
  });
});
