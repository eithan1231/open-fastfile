// Telling a browser the address it can actually reach us on.
//
// libdatachannel gathers one host candidate per interface, so behind a NAT every
// candidate this process offers is private — 192.168.x, and a bridge for every
// docker network on the box. A browser on the internet tries all of them, none
// of them route, and the connection dies as an ICE timeout with no error on
// either end. Forwarding the UDP port opens the door; nothing writes down the
// address.
//
// STUN is the usual way to learn that address, and it is not always an answer.
// It reports the mapping a NAT made for the STUN server, and on a symmetric NAT
// that mapping is valid for the STUN server and nobody else — a candidate the
// browser cannot use. A static port forward has no such problem: it is an
// unconditional inbound rule, the same for every source, so `publicIp:port` is
// simply true. It just has to be said out loud.
//
// So this pushes one extra candidate onto every connection. It is the only place
// that reaches into geckos' connectionsManager, because the library has no
// option for an address it cannot discover for itself, and the alternative —
// relaying a 60 Hz shooter through a TURN server — costs every player latency to
// work around one process not knowing its own address.

import type { GeckosServer } from "@geckos.io/server";

/** What geckos hands the client for each candidate, and the shape we add one in. */
interface Candidate {
  candidate: string;
  sdpMid: string;
}

interface Connection {
  additionalCandidates: Candidate[];
}

type CreateConnection = (...args: never[]) => Promise<{ connection?: { id?: string } }>;

interface ConnectionsManager {
  connections: Map<string, Connection | undefined>;
  createConnection: CreateConnection;
}

/**
 * Priority and shape are a real `srflx` candidate's, as libdatachannel emits one
 * — the same address discovered the same way, had STUN been able to discover it.
 * Below the host candidates on purpose, so a player on the LAN still takes the
 * direct route and only someone outside falls through to this.
 */
const candidateFor = (ip: string, port: number): string => `a=candidate:99 1 UDP 1678767871 ${ip} ${port} typ srflx raddr 0.0.0.0 rport 0`;

/**
 * Advertise `ip:port` beside whatever this process gathers for itself.
 *
 * The port is the one the mux bound, which is why it has to be pinned: geckos'
 * `multiplex` shares a single socket across every connection, and libdatachannel
 * picks that socket's port at random from the range it is given. A range and a
 * forwarded port therefore agree only by luck.
 */
export function advertise(io: GeckosServer, ip: string, port: number): void {
  const manager = (io as unknown as { connectionsManager: ConnectionsManager }).connectionsManager;
  const create = manager.createConnection.bind(manager);

  manager.createConnection = async (...args: never[]) => {
    const result = await create(...args);
    const id = result.connection?.id;
    const connection = id === undefined ? undefined : manager.connections.get(id);

    // Before the client's first poll, and geckos only ever drains this array —
    // so a candidate pushed here is served with the ones being gathered.
    connection?.additionalCandidates.push({ candidate: candidateFor(ip, port), sdpMid: "0" });

    return result;
  };
}

/** Anything a browser out on the internet cannot route to, so cannot be advertised. */
export function isPrivate(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return true;
  }

  // 172.16/12 is the docker range, and 100.64/10 is carrier-grade NAT, behind
  // which no forward you can make is reachable at all.
  return (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
