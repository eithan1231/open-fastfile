// What the HUD is told, and by whom.
//
// Two things are under test here and they are separate on purpose. `unseenEvents`
// is the de-dupe that makes a repeated tail safe, and it lives in the transport
// (net/connection.ts) beside the other thing that file drops as already accounted
// for. `Hud` is the rule about where a number may come from: the server's
// snapshot, never this browser's prediction of it.

import { describe, expect, it } from "vitest";
import type { GameEvent } from "@3d/shared/net/messages/events.js";
import type { DamageCause } from "@3d/shared/game/damage.js";
import type { JoinedMessage } from "@3d/shared/net/messages/session.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { PlayerState } from "@3d/shared/sim/player.js";
import { DEFAULT_COMBAT_RULES } from "@3d/shared/game/rules.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { encodePacket, MessageType } from "@3d/shared/net/packet.js";
import { Connection, unseenEvents } from "../src/net/connection.js";
import { Hud } from "../src/app/hud.js";
import { createUiState } from "../src/app/uiBridge.js";

const registry = new WeaponRegistry([
  { id: "test_mp", game: "iw5", display: "M4A1", slot: "primary", def: weaponDef({ clipSize: 30 }), attachments: [] } satisfies WeaponEntry,
]);

/** A player state with only the fields the HUD reads; the rest never leaves this file. */
function state(over: Partial<PlayerState> = {}): PlayerState {
  return {
    movement: {} as PlayerState["movement"],
    weaponIndex: 0,
    attachments: [],
    weapon: { state: "idle", ammo: 30 } as PlayerState["weapon"],
    slot: 0,
    spareIndex: null,
    spareAttachments: [],
    armed: 0,
    swapping: false,
    stowed: false,
    team: null,
    health: 100,
    dead: false,
    sinceDamage: 10,
    respawnIn: 0,
    points: 0,
    ...over,
  };
}

function joined(over: Partial<JoinedMessage> = {}): JoinedMessage {
  return { you: "me", world: "dome-mw3", tickRate: 60, gametype: "default", rules: DEFAULT_COMBAT_RULES, eventId: 0, spawned: true, classes: true, ...over };
}

/** A HUD in a world, on foot, with nothing behind it yet. */
function setup() {
  const ui = createUiState();
  const hud = new Hud(ui, () => registry);
  hud.setWalking(true);
  return { ui, hud };
}

const death = (id: number, victim: string, killer: string | null, cause: DamageCause = "bullet"): GameEvent => ({ kind: "death", id, victim, killer, cause });

describe("the de-dupe a repeated tail relies on", () => {
  it("passes an event on once, however many times the tail carries it", () => {
    const tail = [death(1, "b", "a")];
    const first = unseenEvents(tail, 0);
    expect(first.events).toEqual(tail);
    expect(first.seen).toBe(1);

    // The same tail on the next thirty ticks, which is exactly what a game server
    // sends: without this the kill feed would grow a line a tick for half a second.
    const again = unseenEvents(tail, first.seen);
    expect(again.events).toEqual([]);
    expect(again.seen).toBe(1);

    // And a new event in the same tail still gets through, which is what rules out
    // a de-dupe that simply dropped every tail after the first.
    const mixed = unseenEvents([...tail, death(2, "c", "a")], again.seen);
    expect(mixed.events).toEqual([death(2, "c", "a")]);
    expect(mixed.seen).toBe(2);
  });

  it("is sound over the wrap, which is where a plain comparison stops being", () => {
    // 65535 is the last id before the counter turns over; 1 is two events later.
    expect(unseenEvents([death(65535, "b", "a")], 65534).events).toHaveLength(1);
    expect(unseenEvents([death(1, "b", "a")], 65535).events).toHaveLength(1);
    // And the one just before it is still old, wrap or no wrap.
    expect(unseenEvents([death(65534, "b", "a")], 65535).events).toEqual([]);
  });

  it("reports nothing at all before `joined` has named a watermark", () => {
    // A snapshot that overtook the join. Nothing in it can be news — this client
    // was not in the game when any of it happened — and, in a match an hour old,
    // guessing a watermark of zero would ignore every event until the counter
    // wrapped past 32768.
    const before = unseenEvents([death(40000, "b", "a")], undefined);
    expect(before.events).toEqual([]);
    expect(before.seen).toBeUndefined();
  });
});

describe("the connection that does the de-duping", () => {
  /**
   * Driven through the packet decoder rather than by calling the filter, because
   * what is under test is the wiring: that `joined` sets the watermark and that
   * each snapshot leaves it where it left off. A filter called with a watermark
   * nobody keeps would pass every test in the block above.
   */
  function client() {
    const heard: GameEvent[] = [];
    const connection = new Connection(
      { onJoined: () => undefined, onSnapshot: (correction) => void heard.push(...correction.events), onClosed: () => undefined },
      "hash",
    );
    const receive = (bytes: Uint8Array) => (connection as unknown as { receive(data: unknown): void }).receive(bytes);
    return { heard, receive };
  }

  const tail = (events: GameEvent[]) => encodePacket(MessageType.snapshot, { tick: 1, ack: 0, presence: null, players: [], actors: [], counters: [], events });

  it("hears each event once across the snapshots that repeat it", () => {
    const { heard, receive } = client();
    receive(encodePacket(MessageType.joined, joined({ eventId: 40000 })));

    const repeated = [death(40001, "b", "a")];
    for (let i = 0; i < 30; i++) {
      receive(tail(repeated));
    }
    expect(heard).toEqual(repeated);

    receive(tail([...repeated, death(40002, "c", "a")]));
    expect(heard).toEqual([...repeated, death(40002, "c", "a")]);
  });

  it("ignores what was in the tail when it arrived, however far the count had got", () => {
    const { heard, receive } = client();
    // A match an hour old: the counter is past half its range, which is the case a
    // watermark of zero would read as ancient and ignore for the next 25000 events.
    receive(encodePacket(MessageType.joined, joined({ eventId: 40000 })));
    receive(tail([death(39998, "b", "a"), death(39999, "c", "a")]));
    expect(heard).toEqual([]);
    receive(tail([death(40001, "d", "a")]));
    expect(heard).toEqual([death(40001, "d", "a")]);
  });
});

describe("whose numbers the HUD shows", () => {
  it("takes health from the server's snapshot and refuses this client's own account of it", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    hud.snapshot(state({ health: 40 }), [], 0);
    expect(ui.hud.player.value).toMatchObject({ health: 40, maxHealth: 100 });

    // The local player, still predicting full health because nothing local ever
    // takes any off. It must not reach the bar: this is the mutation the whole
    // shape of `Hud` exists to prevent, and it is live — `App` calls `local`
    // every frame.
    hud.local(state({ health: 100 }));
    expect(ui.hud.player.value!.health).toBe(40);

    // The control that stops the line above passing for the wrong reason: with no
    // server answering, the local account is the only one there is.
    const offline = setup();
    offline.hud.local(state({ health: 100 }));
    expect(offline.ui.hud.player.value!.health).toBe(100);
  });

  it("takes the bar's denominator from the match's rules, not from a hundred", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ rules: { ...DEFAULT_COMBAT_RULES, maxHealth: 30 } }), "me");
    hud.snapshot(state({ health: 15 }), [], 0);
    expect(ui.hud.player.value).toMatchObject({ health: 15, maxHealth: 30 });
  });

  it("shows the magazine and the weapon by name, and says when it is being reloaded", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    hud.snapshot(state({ weapon: { state: "idle", ammo: 7 } as PlayerState["weapon"] }), [], 0);
    expect(ui.hud.player.value!.weapon).toEqual({ name: "M4A1", ammo: 7, reloading: false });

    hud.snapshot(state({ weapon: { state: "reloading", ammo: 0 } as PlayerState["weapon"] }), [], 0);
    expect(ui.hud.player.value!.weapon).toEqual({ name: "M4A1", ammo: 0, reloading: true });

    // A weapon this catalogue does not hold is drawn as nothing rather than as
    // somebody else's gun.
    hud.snapshot(state({ weaponIndex: 9 }), [], 0);
    expect(ui.hud.player.value!.weapon).toBeNull();
  });

  it("carries the death countdown, and writes nothing at all outside the world", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    hud.snapshot(state({ dead: true, health: 0, respawnIn: 2.55 }), [], 0);
    // Rounded to a tenth, which is what the widget prints — and what keeps this
    // signal from being replaced sixty times a second while it counts.
    expect(ui.hud.player.value).toMatchObject({ dead: true, respawnIn: 2.6 });

    hud.setWalking(false);
    expect(ui.hud.player.value).toBeNull();
    hud.snapshot(state({ health: 12 }), [], 0);
    expect(ui.hud.player.value).toBeNull();
  });

  it("replaces the signal only when something a player could see has changed", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    hud.snapshot(state(), [], 0);
    const first = ui.hud.player.value;
    // The same state on the next tick: an identical object each time would
    // re-render the health and ammunition widgets at the tick rate.
    hud.snapshot(state(), [], 16);
    expect(ui.hud.player.value).toBe(first);
    hud.snapshot(state({ health: 99 }), [], 32);
    expect(ui.hud.player.value).not.toBe(first);
  });
});

describe("what the HUD does with an event", () => {
  it("shows the last hit, and a lethal one differently", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    expect(ui.hud.hit.value).toBeNull();

    hud.snapshot(state(), [{ kind: "hit", id: 4, location: "torsoUpper", lethal: false }], 0);
    expect(ui.hud.hit.value).toEqual({ id: 4, lethal: false });

    // A second marker is a different id, which is what the widget restarts its
    // flash on: two rounds of a burst are two marks.
    hud.snapshot(state(), [{ kind: "hit", id: 5, location: "head", lethal: true }], 16);
    expect(ui.hud.hit.value).toEqual({ id: 5, lethal: true });
  });

  it("writes a feed line per death, newest first, with the names the lobby gave", () => {
    const { ui, hud } = setup();
    ui.lobby.value = {
      code: "ABC123",
      private: false,
      map: "dome-mw3",
      mode: "Free Roam",
      gametype: "default",
      playing: true,
      startsAt: null,
      host: false,
      invite: null,
      players: [
        { id: "me", username: "Alex", host: true },
        { id: "them", username: "Someone", host: false },
      ],
    };
    hud.joined(joined(), "me");

    hud.snapshot(state(), [death(1, "them", "me")], 0);
    hud.snapshot(state(), [death(2, "me", "them")], 100);
    expect(ui.hud.feed.value).toEqual([
      { id: 2, killer: "Someone", victim: "Alex", mine: true, how: null },
      { id: 1, killer: "Alex", victim: "Someone", mine: true, how: null },
    ]);

    // Nobody this browser has heard of, and nobody at all: an id stands in for a
    // name, and the world gets no name — the line says how instead.
    hud.snapshot(state(), [death(3, "ghost", null, "outOfWorld")], 200);
    expect(ui.hud.feed.value[0]).toEqual({ id: 3, killer: null, victim: "ghost", mine: false, how: "fell out of the world" });
  });

  /** Nobody else earned it, so nobody else is named: the world's doing and their own read differently. */
  it("says how a suicide happened, and names no killer for one", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    hud.snapshot(state(), [death(1, "me", "me", "explosion"), death(2, "me", null, "explosion"), death(3, "me", null, "script")], 0);
    expect(ui.hud.feed.value.map((line) => [line.killer, line.how])).toEqual([
      [null, "died"],
      [null, "was blown up"],
      [null, "blew themselves up"],
    ]);
  });

  it("keeps the feed short, and lets a line go once it is old", () => {
    const { ui, hud } = setup();
    hud.joined(joined(), "me");
    for (let i = 1; i <= 8; i++) {
      hud.snapshot(state(), [death(i, "b", "a")], i);
    }
    expect(ui.hud.feed.value.map((line) => line.id)).toEqual([8, 7, 6, 5, 4]);

    // Seven seconds after the last of them arrived, the feed is empty — and a
    // snapshot with no events in it is what does the expiring, since that is all
    // there is at the quiet end of a match.
    hud.snapshot(state(), [], 8 + 7001);
    expect(ui.hud.feed.value).toEqual([]);
  });

  it("holds nothing over from one match to the next", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ rules: { ...DEFAULT_COMBAT_RULES, maxHealth: 30 } }), "me");
    hud.snapshot(state({ health: 12 }), [death(1, "b", "a"), { kind: "hit", id: 2, location: "head", lethal: true }], 0);
    hud.clear();
    expect(ui.hud.player.value).toBeNull();
    expect(ui.hud.hit.value).toBeNull();
    expect(ui.hud.feed.value).toEqual([]);

    // And the rules went with it: the next world is offline until a server says
    // otherwise, at the default ceiling.
    hud.setWalking(true);
    hud.local(state({ health: 100 }));
    expect(ui.hud.player.value).toMatchObject({ health: 100, maxHealth: DEFAULT_COMBAT_RULES.maxHealth });
  });
});

describe("the match's own numbers", () => {
  const zombies: GametypeDecl = { id: "zombies", display: "Zombies", teams: ["survivors"], counters: ["round"], points: true };

  it("shows the gametype's counters by name, in its order, as the snapshot carries them", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ gametype: "zombies" }), "me", zombies);
    expect(ui.hud.counters.value).toEqual([{ name: "round", value: 0 }]);
    hud.counters([3]);
    expect(ui.hud.counters.value).toEqual([{ name: "round", value: 3 }]);
    // The same value again is not a new signal: this runs every tick.
    const shown = ui.hud.counters.value;
    hud.counters([3]);
    expect(ui.hud.counters.value).toBe(shown);
  });

  it("shows this player's points where the gametype keeps them, and nothing where it does not", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ gametype: "zombies" }), "me", zombies);
    hud.snapshot(state({ points: 1250 }), [], 0);
    expect(ui.hud.points.value).toBe(1250);

    const plain = setup();
    plain.hud.joined(joined(), "me", { id: "default", display: "Free Roam", teams: [] });
    plain.hud.snapshot(state({ points: 0 }), [], 0);
    expect(plain.ui.hud.points.value).toBeNull();
    expect(plain.ui.hud.counters.value).toEqual([]);
  });

  it("shows no countdown to a player the gametype will bring back itself", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ rules: { ...DEFAULT_COMBAT_RULES, respawnDelay: null } }), "me", zombies);
    hud.snapshot(state({ dead: true, health: 0, respawnIn: 0 }), [], 0);
    expect(ui.hud.player.value).toMatchObject({ dead: true, respawnIn: null });
  });

  it("holds none of them over from one match to the next", () => {
    const { ui, hud } = setup();
    hud.joined(joined({ gametype: "zombies" }), "me", zombies);
    hud.snapshot(state({ points: 90 }), [], 0);
    hud.counters([4]);
    hud.clear();
    expect(ui.hud.points.value).toBeNull();
    expect(ui.hud.counters.value).toEqual([]);
  });
});
