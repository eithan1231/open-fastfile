// A game that is over, reported to the api until the api has heard.
//
// The report is the only thing that reopens a lobby, so one lost to a blip in
// the network would leave its players in a match that has already ended. The
// pass is driven by hand, as the loop would drive it once a second.

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.js";
import type { FinishedGame, Games } from "../src/games.js";
import { Housekeeping } from "../src/housekeeping.js";

function setup(answers: ("ok" | "fail")[]) {
  let finished: FinishedGame[] = [];
  const refusals: [string, string][] = [];
  const games = {
    all: () => [],
    finished: () => finished.splice(0),
    takeRefusals: () => refusals.splice(0),
    drop: vi.fn(),
  } as unknown as Games;
  const gameReport = vi.fn(async () => {
    if (answers.shift() === "fail") {
      throw new Error("api unreachable");
    }
    return { ok: true as const };
  });
  const api = { client: { gameReport } } as unknown as Api;
  const housekeeping = new Housekeeping(games, api);
  /** One pass, and whatever the report it sent resolved to. */
  const pass = async () => {
    await (housekeeping as unknown as { loopIteration(): Promise<void> }).loopIteration();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const end = (id: string, ending: FinishedGame["ending"] = "expired") =>
    void (finished = [{ game: { id, match: { failed: "boom" } } as unknown as FinishedGame["game"], ending }]);
  const refuse = (id: string, reason: string) => void refusals.push([id, reason]);
  return { games, gameReport, pass, end, refuse, housekeeping };
}

describe("reporting a game over", () => {
  it("drops it at once, and reports it once when the api answers", async () => {
    const { games, gameReport, pass, end } = setup(["ok"]);
    end("g-1");
    await pass();
    await pass();
    expect(games.drop).toHaveBeenCalledWith("g-1");
    expect(gameReport).toHaveBeenCalledTimes(1);
    expect(gameReport).toHaveBeenCalledWith({ gameId: "g-1" }, { status: "ended" });
  });

  it("keeps reporting it until the api hears, and then stops", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gameReport, pass, end } = setup(["fail", "fail", "ok"]);
    end("g-1");
    for (let i = 0; i < 5; i++) {
      await pass();
    }
    expect(gameReport).toHaveBeenCalledTimes(3);
    // Said once, not once a pass for as long as the api is away.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("reporting a game refused", () => {
  it("reports a refused order at once, without waiting for the next pass", async () => {
    const { gameReport, refuse, housekeeping } = setup(["ok"]);
    refuse("g-1", "already hosting 4");
    housekeeping.reportRefusals();
    expect(gameReport).toHaveBeenCalledWith({ gameId: "g-1" }, { status: "refused", reason: "already hosting 4" });
  });

  it("keeps reporting it until the api hears", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gameReport, refuse, housekeeping, pass } = setup(["fail", "ok"]);
    refuse("g-1", "full");
    housekeeping.reportRefusals();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pass();
    await pass();
    expect(gameReport).toHaveBeenCalledTimes(2);
  });

  it("reports a game that threw as refused, so its lobby is placed elsewhere", async () => {
    const { gameReport, pass, end } = setup(["ok"]);
    end("g-1", "errored");
    await pass();
    expect(gameReport).toHaveBeenCalledWith({ gameId: "g-1" }, { status: "refused", reason: "it threw on its tick: boom" });
  });
});
