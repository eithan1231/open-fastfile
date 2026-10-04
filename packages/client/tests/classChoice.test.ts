import { describe, expect, it } from "vitest";
import { ClassChoice } from "../src/app/classChoice.js";
import { createUiState } from "../src/app/uiBridge.js";

/** In a match, spawned with `index`, and the server's answer heard. */
function spawnedWith(index: number) {
  const ui = createUiState();
  const classes = new ClassChoice(ui);
  ui.classChoice.value = "spawn";
  expect(classes.chose(index)).toBe(true);
  expect(classes.answered(index, "now", "Spawn")).toBeNull();
  classes.snapshot(false);
  return { ui, classes };
}

/** Pick a class from the pause menu's class menu. */
function change(ui: ReturnType<typeof createUiState>, classes: ClassChoice, index: number): boolean {
  ui.classChoice.value = "change";
  return classes.chose(index);
}

describe("the class menu's marks", () => {
  it("are the class chosen on joining, at once, with nothing to say about it", () => {
    const { ui } = spawnedWith(2);
    expect(ui.playingClass.value).toBe(2);
    expect(ui.pendingClass.value).toBeNull();
    expect(ui.classChoice.value).toBeNull();
  });

  it("wait for the server's answer on a change, and say what it was", () => {
    const { ui, classes } = spawnedWith(0);
    expect(change(ui, classes, 3)).toBe(false);
    // Nothing moves until the server says.
    expect([ui.playingClass.value, ui.pendingClass.value]).toEqual([0, null]);

    expect(classes.answered(3, "nextSpawn", "Sniper")).toBe("Sniper from your next spawn");
    expect([ui.playingClass.value, ui.pendingClass.value]).toEqual([0, 3]);

    change(ui, classes, 1);
    expect(classes.answered(1, "now", "Rusher")).toBe("Now playing Rusher");
    expect([ui.playingClass.value, ui.pendingClass.value]).toEqual([1, null]);

    change(ui, classes, 4);
    expect(classes.answered(4, "refuse", "Class 5")).toBe("You can't change class now");
    expect([ui.playingClass.value, ui.pendingClass.value]).toEqual([1, null]);
  });

  it("say nothing when the class in hand is chosen again, which cancels a change waiting", () => {
    const { ui, classes } = spawnedWith(0);
    change(ui, classes, 3);
    classes.answered(3, "nextSpawn", "Sniper");
    change(ui, classes, 0);
    expect(classes.answered(0, "now", "Spawn")).toBeNull();
    expect(ui.pendingClass.value).toBeNull();
  });

  it("move the waiting class into hand when the player gets up again, and not before", () => {
    const { ui, classes } = spawnedWith(0);
    change(ui, classes, 3);
    classes.answered(3, "nextSpawn", "Sniper");
    classes.snapshot(false);
    classes.snapshot(true);
    expect(ui.playingClass.value).toBe(0);
    classes.snapshot(false);
    expect([ui.playingClass.value, ui.pendingClass.value]).toEqual([3, null]);
  });

  it("say so when the class that was to spawn them is refused", () => {
    const ui = createUiState();
    const classes = new ClassChoice(ui);
    ui.classChoice.value = "spawn";
    classes.chose(1);
    expect(classes.answered(1, "refuse", "Rusher")).toMatch(/refused/);
    expect(ui.playingClass.value).toBeNull();
  });

  /** Not in the match yet is not dead: the first snapshot with a body in it is not a respawn. */
  it("do not count arriving as getting up", () => {
    const ui = createUiState();
    const classes = new ClassChoice(ui);
    ui.pendingClass.value = 2;
    classes.snapshot(undefined);
    classes.snapshot(false);
    expect(ui.playingClass.value).toBeNull();
  });

  it("are forgotten on leaving the match", () => {
    const { ui, classes } = spawnedWith(0);
    ui.canChooseClass.value = true;
    classes.clear();
    expect([ui.classChoice.value, ui.playingClass.value, ui.pendingClass.value, ui.canChooseClass.value]).toEqual([null, null, null, false]);
  });
});
