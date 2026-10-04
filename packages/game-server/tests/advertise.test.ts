// The address a browser is told to use.
//
// No socket and no geckos: `advertise` wraps one method on the connections
// manager and pushes onto one array, so a stand-in with those two things is the
// whole surface. What is under test is that a connection's candidate list ends
// up carrying the forwarded address — the thing whose absence fails as silence
// on every client at once.

import { describe, expect, it } from "vitest";
import type { GeckosServer } from "@geckos.io/server";
import { advertise, isPrivate } from "../src/net/advertise.js";

interface Connection {
  additionalCandidates: { candidate: string; sdpMid: string }[];
}

/** geckos, reduced to the two things advertise() touches. */
function fakeGeckos(): { io: GeckosServer; open: (id: string) => Promise<Connection> } {
  const connections = new Map<string, Connection>();
  const manager = {
    connections,
    createConnection: async (id: string) => {
      // The real one gathers candidates after this resolves, which is why the
      // array exists to be pushed onto rather than replaced.
      connections.set(id, { additionalCandidates: [] });
      return { connection: { id } };
    },
  };
  const io = { connectionsManager: manager } as unknown as GeckosServer;
  return {
    io,
    open: async (id: string) => {
      await (manager.createConnection as (id: string) => Promise<unknown>)(id);
      return connections.get(id)!;
    },
  };
}

describe("advertise", () => {
  it("adds the forwarded address to a new connection's candidates", async () => {
    const { io, open } = fakeGeckos();
    advertise(io, "203.0.113.7", 20000);

    const { additionalCandidates } = await open("a");
    expect(additionalCandidates).toHaveLength(1);
    expect(additionalCandidates[0]?.candidate).toContain("203.0.113.7 20000 typ srflx");
    expect(additionalCandidates[0]?.sdpMid).toBe("0");
  });

  it("adds it to every connection, not only the first", async () => {
    const { io, open } = fakeGeckos();
    advertise(io, "203.0.113.7", 20000);

    for (const id of ["a", "b", "c"]) {
      expect((await open(id)).additionalCandidates).toHaveLength(1);
    }
  });

  it("ranks it below the host candidates, so a player on the LAN stays direct", async () => {
    const { io, open } = fakeGeckos();
    advertise(io, "203.0.113.7", 20000);

    const priority = Number((await open("a")).additionalCandidates[0]?.candidate.split(" ")[3]);
    // libdatachannel gives a host candidate 2114977791 and below.
    expect(priority).toBeLessThan(2114975743);
  });
});

describe("isPrivate", () => {
  it("knows what a browser on the internet cannot route to", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.10.200", "169.254.1.1", "172.17.0.1", "172.31.255.1"]) {
      expect(isPrivate(ip), ip).toBe(true);
    }
    // Carrier-grade NAT: no forward you can make is reachable behind one, so
    // advertising the address you see there would be advertising a dead end.
    expect(isPrivate("100.64.0.1")).toBe(true);
  });

  it("passes a public address, including ones next to the private ranges", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "192.167.0.1"]) {
      expect(isPrivate(ip), ip).toBe(false);
    }
  });
});
