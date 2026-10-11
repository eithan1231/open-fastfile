// What the HUD is told, and by whom.
//
// Two things are under test here and they are separate on purpose. `SeenEvents`
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
import { Connection, SeenEvents } from "../src/net/connection.js";
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
    respawnIn: 0,
    points: 0,
    ...over,
  };
}

function joined(over: Partial<JoinedMessage> = {}): JoinedMessage {
  return { tickRate: 60, gametype: "default", rules: RULES, eventId: 0, spawned: true, classes: true, ...over };
}

/** What `joined` says of the default rules: the ceiling, and that a death counts down. */
const RULES: JoinedMessage["rules"] = { maxHealth: DEFAULT_COMBAT_RULES.maxHealth, timedRespawn: true };

/** A HUD in a world, on foot, with nothing behind it yet. */
function setup() {
  const ui = createUiState();
  const hud = new Hud(ui, () => registry);
  hud.setWalking(true);
  return { ui, hud };
}

const death = (id: number, victim: string, killer: string | null, cause: DamageCause = "bullet"): GameEvent => ({ kind: "death", id, victim, killer, cause });

describe("the de-dupe a repeated tail relies on", () => {
  const ids = (events: readonly GameEvent[]) => events.map((event) => event.id);

  it("passes an event on once, however many times the tail carries it", () => {
    const seen = new SeenEvents(0);
    const tail = [death(1, "b", "a")];
    expect(seen.unseen(tail)).toEqual(tail);

    // The same tail on the next thirty ticks, which is exactly what a game server
    // sends: without this the kill feed would grow a line a tick for half a second.
    expect(seen.unseen(tail)).toEqual([]);

    // And a new event in the same tail still gets through, which is what rules out
    // a de-dupe that simply dropped every tail after the first.
    expect(seen.unseen([...tail, death(2, "c", "a")])).toEqual([death(2, "c", "a")]);
  });

  it("takes an older id that arrives after a newer one, and takes it once", () => {
    // A tail goes out hit markers first and a full one takes turns, so ids do not
    // arrive in order. A watermark at the newest would have dropped 11 and 12.
    const seen = new SeenEvents(10);
    expect(ids(seen.unseen([death(13, "d", "a")]))).toEqual([13]);
    expect(ids(seen.unseen([death(11, "b", "a"), death(12, "c", "a"), death(13, "d", "a")]))).toEqual([11, 12]);
    expect(seen.unseen([death(11, "b", "a"), death(12, "c", "a"), death(13, "d", "a")])).toEqual([]);
  });

  it("is sound over the wrap, which is where a plain comparison stops being", () => {
    // 65535 is the last id before the counter turns over; 1 is two events later.
    expect(new SeenEvents(65534).unseen([death(65535, "b", "a")])).toHaveLength(1);
    expect(new SeenEvents(65535).unseen([death(1, "b", "a")])).toHaveLength(1);
    // And the one just before it is still old, wrap or no wrap.
    expect(new SeenEvents(65535).unseen([death(65534, "b", "a")])).toEqual([]);

    // Out of order across it, too.
    const seen = new SeenEvents(65530);
    expect(ids(seen.unseen([death(2, "b", "a")]))).toEqual([2]);
    expect(ids(seen.unseen([death(65533, "c", "a"), death(2, "b", "a")]))).toEqual([65533]);
  });

  it("takes nothing issued before the counter `joined` named", () => {
    // In a match an hour old the counter is past half its range, which a cursor of
    // zero would read as ancient until it wrapped.
    const seen = new SeenEvents(40000);
    expect(seen.unseen([death(39999, "b", "a"), death(40000, "c", "a")])).toEqual([]);
    expect(ids(seen.unseen([death(40001, "d", "a")]))).toEqual([40001]);
  });

  it("forgets an id once it is far behind the newest, and still refuses it", () => {
    const seen = new SeenEvents(0);
    expect(ids(seen.unseen([death(1, "b", "a")]))).toEqual([1]);
    expect(ids(seen.unseen([death(5000, "c", "a")]))).toEqual([5000]);
    // 1 is behind the floor now rather than in the set, and is old either way.
    expect(seen.unseen([death(1, "b", "a")])).toEqual([]);
    expect(ids(seen.unseen([death(4999, "d", "a")]))).toEqual([4999]);
  });
});

describe("the connection that does the de-duping", () => {
  /**
   * Driven through the packet decoder rather than by calling the filter, because
   * what is under test is the wiring: that `joined` names where the count starts
   * and that one set is kept across snapshots. A filter nobody keeps would pass
   * every test in the block above.
   */
  function client() {
    const heard: GameEvent[] = [];
    const ticks: number[] = [];
    const connection = new Connection(
      {
        onJoined: () => undefined,
        onSnapshot: (correction) => {
          ticks.push(correction.tick);
          heard.push(...correction.events);
        },
        onClosed: () => undefined,
      },
      "hash",
    );
    const receive = (bytes: Uint8Array) => (connection as unknown as { receive(data: unknown): void }).receive(bytes);
    return { heard, ticks, receive };
  }

  const tail = (tick: number, events: GameEvent[] = []) =>
    encodePacket(MessageType.snapshot, { tick, ack: 0, presence: null, players: [], actors: [], counters: [], events });

  it("hears each event once across the snapshots that repeat it", () => {
    const { heard, receive } = client();
    receive(encodePacket(MessageType.joined, joined({ eventId: 40000 })));

    const repeated = [death(40001, "b", "a")];
    for (let i = 0; i < 30; i++) {
      receive(tail(1 + i, repeated));
    }
    expect(heard).toEqual(repeated);

    receive(tail(31, [...repeated, death(40002, "c", "a")]));
    expect(heard).toEqual([...repeated, death(40002, "c", "a")]);
  });

  it("ignores what was in the tail when it arrived, however far the count had got", () => {
    const { heard, receive } = client();
    receive(encodePacket(MessageType.joined, joined({ eventId: 40000 })));
    receive(tail(1, [death(39998, "b", "a"), death(39999, "c", "a")]));
    expect(heard).toEqual([]);
    receive(tail(2, [death(40001, "d", "a")]));
    expect(heard).toEqual([death(40001, "d", "a")]);
  });

  it("drops a snapshot older than one it has taken, and one that overtook `joined`", () => {
    // The channel is unordered. An old snapshot applied late would put every peer
    // back a tick and rewind this player to an ack already passed.
    const { heard, ticks, receive } = client();
    receive(tail(4, [death(1, "b", "a")]));
    expect(ticks).toEqual([]);

    receive(encodePacket(MessageType.joined, joined()));
    receive(tail(6));
    receive(tail(5, [death(2, "c", "a")]));
    receive(tail(6));
    receive(tail(7));
    expect(ticks).toEqual([6, 7]);
    // What the dropped one carried is not lost with it: a later tail repeats it.
    expect(heard).toEqual([]);
    receive(tail(8, [death(2, "c", "a")]));
    expect(heard).toEqual([death(2, "c", "a")]);
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
    hud.joined(joined({ rules: { ...RULES, maxHealth: 30 } }), "me");
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

    hud.snapshot(state(), [{ kind: "hit", id: 4, lethal: false }], 0);
    expect(ui.hud.hit.value).toEqual({ id: 4, lethal: false });

    // A second marker is a different id, which is what the widget restarts its
    // flash on: two rounds of a burst are two marks.
    hud.snapshot(state(), [{ kind: "hit", id: 5, lethal: true }], 16);
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
    hud.joined(joined({ rules: { ...RULES, maxHealth: 30 } }), "me");
    hud.snapshot(state({ health: 12 }), [death(1, "b", "a"), { kind: "hit", id: 2, lethal: true }], 0);
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
    hud.joined(joined({ rules: { ...RULES, timedRespawn: false } }), "me", zombies);
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
