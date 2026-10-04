// The held weapon's state machine (engine/player/weapon.ts): commands in, events out,
// states timed by the weapon file and clips scaled to fit them.

import { describe, expect, it } from "vitest";
import { CROSSFADE, WeaponController, type WeaponData, type WeaponEvent } from "../src/sim/weapon.js";
import type { WeaponDef } from "../src/sim/weaponDef.js";
import { weaponDef } from "../testing/weaponDef.js";

function setup(overrides: Partial<WeaponDef> = {}) {
  const weapon = new WeaponController(weaponDef(overrides));
  const events: WeaponEvent[] = [];
  weapon.on((e) => events.push(e));
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 100) {
      weapon.update(1 / 100);
    }
  };
  const played = () => events.filter((e) => e.type === "play").map((e) => (e as { clip: string }).clip);
  const shots = () => events.filter((e) => e.type === "shot").length;
  return { weapon, events, run, played, shots };
}

describe("WeaponController", () => {
  it("raises for the weapon file's time, playing the clip fast enough to fit", () => {
    const { weapon, events, run } = setup();
    weapon.raise({ first: true });
    expect(events).toContainEqual(expect.objectContaining({ type: "play", clip: "first_pullout", rate: 1.2 / 0.8 }));
    run(0.7);
    expect(weapon.data.state).toBe("raising");
    run(0.2);
    expect(weapon.data.state).toBe("idle");
  });

  it("fires every fireTime while the trigger is held, then reloads the empty magazine by itself", () => {
    const { weapon, run, shots, played } = setup();
    weapon.ready();
    weapon.setInput({ trigger: true });
    run(0.25);
    expect(shots()).toBe(3);
    expect(weapon.data.ammo).toBe(0);
    // The last shot's clip holds the weapon until its interruptible time.
    run(0.05);
    expect(weapon.data.state).not.toBe("reloading");
    run(0.3);
    expect(weapon.data.state).toBe("reloading");
    expect(played().at(-1)).toBe("reload_empty");
  });

  it("fires once per press on a single-shot weapon, and a burst per press on a burst one", () => {
    const single = setup({ fireType: "Single Shot" });
    single.weapon.ready();
    single.weapon.setInput({ trigger: true });
    single.run(1);
    expect(single.shots()).toBe(1);
    single.weapon.setInput({ trigger: false });
    single.weapon.setInput({ trigger: true });
    single.run(0.05);
    expect(single.shots()).toBe(2);

    const burst = setup({ fireType: "3-Round Burst", clipSize: 30 });
    burst.weapon.ready();
    burst.weapon.setInput({ trigger: true });
    burst.weapon.setInput({ trigger: false });
    burst.run(1);
    expect(burst.shots()).toBe(3);
  });

  it("refills the magazine at reloadAddTime, with the clip's notetracks on the way", () => {
    const { weapon, events, run } = setup();
    weapon.ready();
    weapon.setInput({ trigger: true });
    run(0.05);
    weapon.setInput({ trigger: false });
    run(0.5);
    expect(weapon.reload()).toBe(true);
    run(1.2);
    expect(weapon.data.ammo).toBe(2);
    run(0.2);
    expect(weapon.data.ammo).toBe(3);
    const cues = events.filter((e) => e.type === "note" || e.type === "reloaded").map((e) => (e.type === "note" ? e.name : "reloaded"));
    expect(cues.slice(-3)).toEqual(["clipout", "clipin", "reloaded"]);
    run(0.7);
    expect(weapon.data.state).toBe("idle");
  });

  it("remembers a reload pressed while a shot holds the weapon, and starts it once it can", () => {
    const { weapon, run } = setup({ clipSize: 30 });
    weapon.ready();
    weapon.setInput({ trigger: true, ads: true });
    run(0.5);
    expect(weapon.reload()).toBe(false); // the last shot is not interruptible yet
    run(0.25);
    expect(weapon.data.state).toBe("reloading");
    run(0.15); // aim still held: the sights drop over adsReloadTransTime
    expect(weapon.data.ads).toBe(0);
  });

  it("will not reload a full magazine, or while raising", () => {
    const { weapon } = setup();
    weapon.raise();
    weapon.restore({ ...weapon.data, ammo: 1 });
    expect(weapon.reload()).toBe(false);
    weapon.ready();
    weapon.restore({ ...weapon.data, ammo: 3 });
    expect(weapon.reload()).toBe(false);
  });

  it("sprints in, loops, and takes the weapon's own sprintOutTime to fire", () => {
    const { weapon, events, run, shots } = setup();
    weapon.ready();
    weapon.setInput({ sprint: true });
    run(0.01);
    expect(events).toContainEqual(expect.objectContaining({ type: "play", clip: "sprint_in", rate: 0.2 / 0.25 }));
    run(0.3);
    expect(weapon.data.state).toBe("sprinting");
    expect(events).toContainEqual(expect.objectContaining({ type: "play", clip: "sprint_loop", loop: true }));

    // Sprint to fire: the trigger drops the weapon out of the sprint and nothing
    // leaves the barrel until that has run — 0.2 s here, and its own number on
    // every weapon (`sprintOutTime`).
    weapon.setInput({ trigger: true });
    run(0.01);
    expect(weapon.data.state).toBe("sprintOut");
    expect(shots()).toBe(0);
    run(0.15);
    expect(weapon.data.state).toBe("sprintOut");
    expect(shots()).toBe(0);
    run(0.05);
    expect(weapon.data.state).toBe("firing");
    expect(shots()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "play", clip: "fire", fade: CROSSFADE }));

    // The same wait from the sights: the sprint has to be paid for either way.
    weapon.setInput({ trigger: false });
    run(1);
    expect(weapon.data.state).toBe("sprinting");
    weapon.setInput({ ads: true, trigger: true });
    run(0.15);
    expect(shots()).toBe(1);
    run(0.06);
    expect(shots()).toBe(2);
  });

  it("banks a press made during a sprint and spends it when the sprint is out", () => {
    // A tap on a single-shot weapon, released well before the sprint-out ends:
    // the shot still leaves, because a press is spendable through the whole
    // sprint (FIRE_STATES) — what it is not is instant.
    const { weapon, run, shots } = setup({ fireType: "Single Shot", clipSize: 30 });
    weapon.ready();
    weapon.setInput({ sprint: true });
    run(0.6);
    expect(weapon.data.state).toBe("sprinting");
    weapon.setInput({ trigger: true });
    run(0.05);
    weapon.setInput({ trigger: false });
    expect(shots()).toBe(0);
    run(0.2);
    expect(shots()).toBe(1);
  });

  it("works a bolt between shots: as long as the weapon file says, and as blocking as a reload", () => {
    // fireTime 0.1 + rechamberTime 0.5, which is the rate of fire; the 0.6 s
    // clip is stretched to the 0.5 s state like every other clip is.
    const { weapon, events, run, shots } = setup({ boltAction: true, fireType: "Single Shot", clipSize: 30 });
    weapon.ready();
    weapon.setInput({ trigger: true, sprint: true });
    run(0.15);
    expect(shots()).toBe(1);
    expect(weapon.data.state).toBe("rechambering");
    expect(events).toContainEqual(expect.objectContaining({ type: "play", clip: "rechamber", rate: 0.6 / 0.5 }));

    // A held trigger does not fire again, a held sprint does not run, and the
    // bolt's own notetracks still arrive.
    weapon.setInput({ trigger: false });
    weapon.setInput({ trigger: true });
    run(0.3);
    expect(shots()).toBe(1);
    expect(weapon.sprinting).toBe(false);
    expect(events).toContainEqual({ type: "note", name: "bolt", clip: "rechamber" });

    // A press made *during* the bolt is dropped, not banked (FIRE_STATES): working
    // the action is as blocking as a reload, so the trigger comes back to a rifle
    // that has to be asked again rather than one that fires the instant it closes.
    run(0.3);
    expect(shots()).toBe(1);
    expect(weapon.data.state).toBe("idle");

    // Asked again, it fires: 0.6 s a shot is the rate, the press is the permission.
    weapon.setInput({ trigger: false });
    weapon.setInput({ trigger: true });
    run(0.15);
    expect(shots()).toBe(2);
    expect(weapon.data.state).toBe("rechambering");
  });

  it("drops a trigger press the weapon cannot spend rather than firing the moment it can", () => {
    const { weapon, run, shots } = setup({ fireType: "Single Shot", clipSize: 30 });
    weapon.ready();
    weapon.setInput({ trigger: true });
    run(0.3);
    expect(shots()).toBe(1);

    // Held all the way through a reload. The magazine change is not a queue for
    // the trigger: the shot a player asked for two seconds ago is not the shot
    // they want the moment the gun comes back.
    expect(weapon.reload()).toBe(true);
    expect(weapon.data.state).toBe("reloading");
    run(4);
    expect(weapon.data.state).toBe("idle");
    expect(shots()).toBe(1);

    // Released and pressed again, it fires at once.
    weapon.setInput({ trigger: false });
    weapon.setInput({ trigger: true });
    run(0.05);
    expect(shots()).toBe(2);
  });

  it("keeps a press made inside a shot's own cooldown: that is the rate of fire, not a block", () => {
    const { weapon, run, shots } = setup({ fireType: "Single Shot", clipSize: 30, times: { ...weaponDef().times, fire: 0.25 } });
    weapon.ready();
    weapon.setInput({ trigger: true });
    run(0.05);
    expect(shots()).toBe(1);

    // Tapped again well inside the cooldown, and released: the round leaves when
    // the weapon is ready, which is what firing a pistol as fast as it goes is.
    weapon.setInput({ trigger: false });
    weapon.setInput({ trigger: true });
    weapon.setInput({ trigger: false });
    run(0.3);
    expect(shots()).toBe(2);
  });

  it("aims down the sights through a bolt, and reloads out of one rather than cycling an empty rifle", () => {
    const { weapon, run, played } = setup({ boltAction: true, fireType: "Single Shot" });
    weapon.ready();
    weapon.setInput({ ads: true });
    run(0.4);
    weapon.setInput({ trigger: true });
    run(0.2);
    expect(weapon.data.state).toBe("rechambering");
    expect(weapon.data.ads).toBe(1); // rechamberWhileAds: the sights stay up
    expect(played().at(-1)).toBe("rechamber_ads");
    expect(weapon.reload()).toBe(true); // a bolt can be cut short by a reload

    // The last round leaves no round to chamber, and the empty reload works the bolt itself.
    weapon.restore({ ...weapon.data, state: "idle", ammo: 1, timer: 0, cooldown: 0, clip: null });
    weapon.setInput({ trigger: false });
    weapon.setInput({ trigger: true });
    run(0.3);
    expect(weapon.data.ammo).toBe(0);
    expect(weapon.data.state).toBe("reloading");
    expect(played().at(-1)).toBe("reload_empty");
  });

  it("loads a segmented reload a round at a time, and the trigger takes it back off the player", () => {
    // reloadStart 0.5 (+1 at 0.3 in), then a 2 s load each (+1 at 1.3 in), then reloadEnd 0.4.
    const { weapon, run, played } = setup({ roundsPerLoad: 1 });
    weapon.ready();
    weapon.restore({ ...weapon.data, ammo: 0 });
    expect(weapon.reload()).toBe(true);
    expect(played().at(-1)).toBe("reload_in");
    run(0.35);
    expect(weapon.data.ammo).toBe(1); // the start loads one, not the whole magazine
    run(0.2);
    expect(weapon.data.state).toBe("reloading");
    expect(played().at(-1)).toBe("reload");
    run(1.4);
    expect(weapon.data.ammo).toBe(2);
    run(0.7);
    expect(weapon.data.state).toBe("reloading"); // another load, not idle

    // The trigger breaks out at the next load's end, with what is already in it.
    weapon.setInput({ trigger: true });
    run(2);
    expect(weapon.data.ammo).toBe(3);
    expect(weapon.data.state).toBe("reloadEnd");
    expect(played().at(-1)).toBe("reload_out");
    run(0.5);
    expect(weapon.data.state).not.toBe("reloadEnd");
  });

  it("stops a segmented reload once the magazine is full, and never plays the empty reload", () => {
    const { weapon, run, played, events } = setup({ roundsPerLoad: 1 });
    weapon.ready();
    weapon.restore({ ...weapon.data, ammo: 1 });
    weapon.reload();
    run(4); // start (+1), one load (+1), and out: two short of nothing to do
    expect(weapon.data.ammo).toBe(3);
    expect(weapon.data.state).toBe("idle");
    expect(played()).not.toContain("reload_empty");
    expect(events.filter((e) => e.type === "reloaded")).toHaveLength(2);
  });

  it("aims over adsTransInTime, and drops the sights to reload", () => {
    const { weapon, run } = setup();
    weapon.ready();
    weapon.setInput({ ads: true });
    run(0.15);
    expect(weapon.data.ads).toBeCloseTo(0.5, 1);
    run(0.2);
    expect(weapon.data.ads).toBe(1);
    weapon.restore({ ...weapon.data, ammo: 1 });
    weapon.reload();
    run(0.35);
    expect(weapon.data.ads).toBe(0);
  });

  it("drops to lowered and raises from there", () => {
    const { weapon, run, played, events } = setup();
    weapon.ready();
    weapon.drop();
    run(0.5);
    expect(weapon.data.state).toBe("lowered");
    weapon.raise();
    expect(played().at(-1)).toBe("pullout");
    expect(events.at(-1)).toEqual({ type: "note", name: "lift", clip: "pullout" }); // a note on frame 0 fires at once
  });

  it("loops a one-frame idle without its clock going astray", () => {
    const { weapon, run } = setup();
    weapon.ready();
    run(2);
    const clip = weapon.data.clip!;
    expect(clip.role).toBe("idle");
    expect(Number.isFinite(clip.time) && clip.time <= 1 / 30).toBe(true);
  });

  it("pauses a held sprint for a reload, and a new sprint press cancels the reload", () => {
    const { weapon, run } = setup();
    weapon.ready();
    weapon.restore({ ...weapon.data, ammo: 1 });
    weapon.setInput({ sprint: true });
    run(0.5);
    expect(weapon.sprinting).toBe(true);
    expect(weapon.reload()).toBe(true);
    run(1);
    expect(weapon.data.state).toBe("reloading");
    expect(weapon.sprinting).toBe(false);
    run(1.1); // still held: the sprint comes back once the reload is done
    expect(weapon.data.ammo).toBe(3);
    expect(weapon.sprinting).toBe(true);

    weapon.restore({ ...weapon.data, ammo: 1 });
    run(0.5);
    weapon.reload();
    run(0.5);
    weapon.setInput({ sprint: false });
    weapon.setInput({ sprint: true });
    run(0.01);
    expect(weapon.data.state).toBe("sprintIn");
    expect(weapon.data.ammo).toBe(1);
  });

  it("pauses a held sprint while aiming or firing, and resumes it after", () => {
    const { weapon, run } = setup({ clipSize: 30 });
    weapon.ready();
    weapon.setInput({ sprint: true });
    run(0.5);
    weapon.setInput({ ads: true });
    run(0.5);
    expect(weapon.sprinting).toBe(false);
    weapon.setInput({ ads: false });
    run(0.5);
    expect(weapon.data.state).toBe("sprinting");
    weapon.setInput({ trigger: true });
    run(0.5);
    expect(weapon.sprinting).toBe(false);
    weapon.setInput({ trigger: false });
    run(1);
    expect(weapon.data.state).toBe("sprinting");
  });

  it("starts aiming while it comes out of a sprint, not after", () => {
    const { weapon, run } = setup();
    weapon.ready();
    weapon.setInput({ sprint: true });
    run(0.5);
    weapon.setInput({ ads: true });
    run(0.1);
    expect(weapon.data.state).toBe("sprintOut");
    expect(weapon.data.ads).toBeGreaterThan(0.2);
  });

  it("reads a reused input object, edges and all", () => {
    // P4: `setInput` no longer copies the whole input to find two edges, and the
    // player hands it the same object every frame. A press still has to read as
    // a press exactly once, and a held sprint still has to cancel a reload.
    const { weapon, run, shots } = setup({ clipSize: 30, fireType: "single" });
    weapon.ready();
    const input = { trigger: false, ads: false, sprint: false };

    input.trigger = true;
    weapon.setInput(input);
    run(0.1);
    expect(shots()).toBe(1); // one press, one shot, however long it is held

    weapon.setInput(input);
    run(0.2);
    expect(shots()).toBe(1);

    input.trigger = false;
    weapon.setInput(input);
    input.trigger = true;
    weapon.setInput(input);
    run(0.1);
    expect(shots()).toBe(2); // released and pressed again: a new edge
  });

  it("keeps all its state in `data`: a JSON copy runs in lockstep with the original", () => {
    const a = setup({ clipSize: 30 });
    a.weapon.ready();
    a.weapon.setInput({ trigger: true, ads: true });
    a.run(0.33);
    const b = new WeaponController(a.weapon.def);
    b.restore(JSON.parse(JSON.stringify(a.weapon.data)) as WeaponData);
    const script = (w: WeaponController) => {
      for (let i = 0; i < 300; i++) {
        if (i === 40) {
          w.setInput({ trigger: false });
        }
        if (i === 60) {
          w.reload();
        }
        if (i === 150) {
          w.setInput({ ads: false, sprint: true });
        }
        w.update(1 / 100);
      }
    };
    script(a.weapon);
    script(b);
    expect(b.data).toEqual(a.weapon.data);
  });

  /**
   * `fired` is how a server learns a shot happened: it replays a client's input
   * and watches the number move (docs/server/README.md). So the one thing it must
   * never do is disagree with the `shot` events the same weapon emits — a counter
   * advanced anywhere but in `shoot` would authorize rounds the state machine
   * never let out, and one advanced nowhere would authorize none at all.
   */
  it("counts exactly the shots it fires, in every state that could add one", () => {
    const { weapon, run, shots } = setup({ clipSize: 30 });
    expect(weapon.data.fired).toBe(0);
    weapon.ready();

    // Held fire, which counts through `idleOrFiring`.
    weapon.setInput({ trigger: true });
    run(0.35);
    expect(shots()).toBeGreaterThan(2);
    expect(weapon.data.fired).toBe(shots());

    // A reload, a sprint and a raise: three whole states that fire nothing, and
    // must add nothing.
    weapon.setInput({ trigger: false });
    const still = weapon.data.fired;
    weapon.reload();
    run(0.3);
    expect(weapon.data.state).toBe("reloading");
    run(2.2);
    expect(weapon.data.fired).toBe(still);
    weapon.setInput({ sprint: true });
    run(0.6);
    expect(weapon.data.state).toBe("sprinting");
    expect(weapon.data.fired).toBe(still);
    weapon.setInput({ sprint: false });
    weapon.drop();
    run(0.5);
    expect(weapon.data.state).toBe("lowered");
    weapon.raise();
    run(0.9);
    expect(weapon.data.state).toBe("idle");
    expect(weapon.data.fired).toBe(still);

    // The trigger out of a sprint, which is the one shot `update` fires from the
    // state machine's own sprintOut branch — and the one an increment placed at a
    // call site rather than inside `shoot` would miss.
    weapon.setInput({ sprint: true });
    run(0.5);
    expect(weapon.data.state).toBe("sprinting");
    weapon.setInput({ trigger: true });
    run(0.02);
    expect(weapon.data.fired).toBe(still);
    run(0.2);
    expect(weapon.data.fired).toBe(still + 1);
    expect(weapon.data.fired).toBe(shots());
  });

  /**
   * Sixteen bits, because that is what the wire carries (net/messages/player.ts).
   * A server takes the difference across a step as `(after - before) & 0xffff`,
   * which is only the number of shots if the counter wraps at the same place.
   */
  it("wraps its shot counter at sixteen bits, where the wire does", () => {
    const { weapon } = setup({ clipSize: 30 });
    weapon.ready();
    weapon.restore({ ...(structuredClone(weapon.data) as WeaponData), fired: 0xffff });
    weapon.setInput({ trigger: true });
    weapon.update(1 / 100);
    expect(weapon.data.fired).toBe(0);
    expect((weapon.data.fired - 0xffff) & 0xffff).toBe(1);
  });
});
