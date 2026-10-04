// The shared loader, and the HttpFetch shape it reads through.
//
// Every response below is a plain object literal. That is the point of
// protocol/http.ts: this package is typechecked with `types: []`, so a test could
// not construct a DOM `Response` even if it wanted to, and does not need to.

import { describe, expect, it } from "vitest";
import { httpWorldSource, type WorldSource } from "../src/worlds/source.js";
import { loadResolvedWorld } from "../src/worlds/load.js";
import type { HttpFetch } from "../src/protocol/http.js";
import { WORLDS_MANIFEST_PATH, worldAssetPath, worldPayloadPath } from "../src/protocol/routes/worlds.js";

/** A fetch over a fixed set of routes. Anything not listed 404s, as the real api would. */
function fakeFetch(routes: Record<string, string | Uint8Array>): { fetch: HttpFetch; seen: string[] } {
  const seen: string[] = [];
  const fetch: HttpFetch = (url) => {
    seen.push(url);
    const body = routes[url];
    if (body === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.reject(new Error("no body")),
        text: () => Promise.resolve(""),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    }
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      text: () => Promise.resolve(new TextDecoder().decode(bytes)),
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    });
  };
  return { fetch, seen };
}

const payload = (sources: Record<string, string>): string => JSON.stringify({ entryPath: "world.world", sources });

const FLAT = `world { name: "Flat" }
spawn { at: 0 1.7 0 }
`;

describe("httpWorldSource", () => {
  it("fetches the manifest and a payload from the documented URLs", async () => {
    const { fetch, seen } = fakeFetch({
      [WORLDS_MANIFEST_PATH]: JSON.stringify([{ slug: "flat", name: "Flat" }]),
      [worldPayloadPath("flat")]: payload({ "world.world": FLAT }),
    });
    const source = httpWorldSource({ fetch });

    expect(await source.manifest()).toEqual([{ slug: "flat", name: "Flat" }]);
    expect((await source.world("flat").payload()).entryPath).toBe("world.world");
    expect(seen).toEqual([WORLDS_MANIFEST_PATH, worldPayloadPath("flat")]);
  });

  it("prefixes a baseUrl, so a game server can reach another origin", async () => {
    const { fetch, seen } = fakeFetch({ [`http://api:9208${worldPayloadPath("flat")}`]: payload({ "world.world": FLAT }) });
    await httpWorldSource({ baseUrl: "http://api:9208", fetch }).world("flat").payload();
    expect(seen).toEqual([`http://api:9208${worldPayloadPath("flat")}`]);
  });

  it("sends a bearer token when given one", async () => {
    const headers: (Record<string, string> | undefined)[] = [];
    const fetch: HttpFetch = (_url, init) => {
      headers.push(init?.headers);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(JSON.parse(payload({ "world.world": FLAT })) as unknown),
        text: () => Promise.resolve(""),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    };
    await httpWorldSource({ fetch, token: "s3cret" }).world("flat").payload();
    expect(headers[0]?.Authorization).toBe("Bearer s3cret");
  });

  it("reports an absent world rather than throwing something unrecognisable", async () => {
    const { fetch } = fakeFetch({});
    const result = await loadResolvedWorld(httpWorldSource({ fetch }).world("nope"));
    expect(result.error).toContain("404");
    expect(result.world).toBeUndefined();
  });

  it("rejects a reply that is not a WorldPayload at all", async () => {
    const { fetch } = fakeFetch({ [worldPayloadPath("flat")]: JSON.stringify({ nope: true }) });
    const result = await loadResolvedWorld(httpWorldSource({ fetch }).world("flat"));
    expect(result.error).toContain("not a WorldPayload");
  });

  it("reports a payload whose entry file is missing", async () => {
    const { fetch } = fakeFetch({ [worldPayloadPath("flat")]: payload({ "other.world": FLAT }) });
    const result = await loadResolvedWorld(httpWorldSource({ fetch }).world("flat"));
    expect(result.error).toContain("no world.world");
  });
});

describe("loadResolvedWorld", () => {
  it("resolves a world fetched over HTTP", async () => {
    const { fetch } = fakeFetch({ [worldPayloadPath("flat")]: payload({ "world.world": FLAT }) });
    const result = await loadResolvedWorld(httpWorldSource({ fetch }).world("flat"));

    expect(result.error).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.world?.name).toBe("Flat");
    expect(result.sources["world.world"]).toBe(FLAT);
  });

  it("fetches an asset through the same source as the sources", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetch, seen } = fakeFetch({
      [worldPayloadPath("hill")]: payload({ "world.world": FLAT }),
      [worldAssetPath("hill", "assets/collision.glb")]: bytes,
    });
    const source = httpWorldSource({ fetch }).world("hill");

    expect(await source.asset("assets/collision.glb")).toEqual(bytes);
    expect(seen).toContain(worldAssetPath("hill", "assets/collision.glb"));
  });

  it("reports an asset it cannot fetch as absent rather than throwing", async () => {
    const { fetch } = fakeFetch({ [worldPayloadPath("hill")]: payload({ "world.world": FLAT }) });
    const source = httpWorldSource({ fetch }).world("hill");

    expect(await source.asset("assets/missing.glb")).toBeUndefined();
  });

  it("takes any WorldSource, not just the HTTP one", async () => {
    const source: WorldSource = {
      describe: "a fake",
      payload: () => Promise.resolve({ entryPath: "world.world", sources: { "world.world": FLAT } }),
      asset: () => Promise.resolve(undefined),
    };
    const result = await loadResolvedWorld(source);
    expect(result.world?.name).toBe("Flat");
  });
});
