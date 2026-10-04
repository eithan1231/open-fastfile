// The route mechanism: the paths it builds, the paths it takes apart, and the
// parse at the edge of the client.
//
// The first group is the one that matters most. `routePath` and `matchRoutePath`
// are inverses, and a builder that disagrees with its matcher is a 404 nobody can
// read — so the round trip is asserted directly, including the two cases that
// made the old hand-written builders awkward: a param with a `.json` suffix, and
// a remainder that keeps its slashes.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bytes, createRouteClient, defineRoute, json, matchRoutePath, routePath } from "../src/protocol/route.js";
import type { HttpFetch } from "../src/protocol/http.js";
import { worldAssetRoute, worldManifestRoute, worldPayloadRoute } from "../src/protocol/routes/worlds.js";

const suffixed = defineRoute({ method: "GET", path: "/worlds/:slug.json", auth: "public", result: json(z.unknown()) });
const remainder = defineRoute({ method: "GET", path: "/worlds/:slug/*", auth: "public", result: bytes() });
const plain = defineRoute({ method: "GET", path: "/api/health", auth: "public", result: json(z.unknown()) });

describe("routePath", () => {
  it("fills a param, a suffixed param and a remainder", () => {
    expect(routePath(plain)).toBe("/api/health");
    expect(routePath(suffixed, { slug: "rust-mw2" })).toBe("/worlds/rust-mw2.json");
    expect(routePath(remainder, { slug: "rust-mw2", rest: "assets/tex.png" })).toBe("/worlds/rust-mw2/assets/tex.png");
  });

  it("encodes a segment and leaves a remainder's slashes alone", () => {
    expect(routePath(suffixed, { slug: "a/b" })).toBe("/worlds/a%2Fb.json");
    expect(routePath(remainder, { slug: "w", rest: "a/b/c.png" })).toBe("/worlds/w/a/b/c.png");
  });

  /**
   * The prefix a world's assets hang off, which App.ts keys its AssetStore with.
   * It has to stay byte-identical to what scene/ loaded through, or a hot reload
   * silently stops invalidating — see protocol/routes/worlds.ts.
   */
  it("builds an empty remainder as the prefix, trailing slash kept", () => {
    expect(routePath(worldAssetRoute, { slug: "rust-mw2", rest: "" })).toBe("/worlds/rust-mw2/");
  });

  it("refuses to build a path it has no value for", () => {
    // @ts-expect-error the point: the types refuse this too.
    expect(() => routePath(suffixed, {})).toThrow(/no value for path param "slug"/);
  });
});

describe("matchRoutePath", () => {
  it("round-trips every declared world route", () => {
    const params = { slug: "hardhat-mw3", rest: "assets/nested/tex.png" };
    expect(matchRoutePath(worldManifestRoute, routePath(worldManifestRoute))).toEqual({});
    expect(matchRoutePath(worldPayloadRoute, routePath(worldPayloadRoute, params))).toEqual({ slug: params.slug });
    expect(matchRoutePath(worldAssetRoute, routePath(worldAssetRoute, params))).toEqual(params);
  });

  it("holds the literal parts of the path, which the host router does not", () => {
    // Hono matches `/worlds/:slug.json` against `/worlds/rust-mw2` too, so this
    // is the only thing standing between a payload route and an asset request.
    expect(matchRoutePath(suffixed, "/worlds/rust-mw2")).toBeUndefined();
    expect(matchRoutePath(suffixed, "/worlds/a/b.json")).toBeUndefined();
    expect(matchRoutePath(plain, "/api/healthx")).toBeUndefined();
  });

  /**
   * The form a traversal arrives in. A host router has already decoded `%2e` to
   * `.` but leaves `%2f` alone, so this second decode is what turns the attempt
   * into the `../` a path guard can refuse — and the params schema does.
   */
  it("decodes once more than the router did, so a guard sees the real value", () => {
    const matched = matchRoutePath(worldAssetRoute, "/worlds/rust-mw2/..%2f..%2fpackage.json");
    expect(matched).toEqual({ slug: "rust-mw2", rest: "../../package.json" });
    expect(worldAssetRoute.params?.safeParse(matched).success).toBe(false);
  });

  it("is not a path at all when the encoding is malformed", () => {
    // Decoding this throws, which must not become a 500 out of a handler.
    expect(matchRoutePath(worldAssetRoute, "/worlds/rust-mw2/%zz")).toBeUndefined();
  });

  it("refuses an empty remainder, which is a prefix rather than a file", () => {
    expect(worldAssetRoute.params?.safeParse({ slug: "rust-mw2", rest: "" }).success).toBe(false);
  });
});

describe("createRouteClient", () => {
  const replying = (status: number, body: unknown): { fetch: HttpFetch; calls: { url: string; method?: string; headers?: Record<string, string> }[] } => {
    const calls: { url: string; method?: string; headers?: Record<string, string> }[] = [];
    const fetch: HttpFetch = (url, init) => {
      calls.push({ url, ...(init?.method === undefined ? {} : { method: init.method }), ...(init?.headers === undefined ? {} : { headers: init.headers }) });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: "OK",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(""),
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer),
      });
    };
    return { fetch, calls };
  };

  const table = {
    plain,
    remainder,
    posted: defineRoute({ method: "POST", path: "/api/thing", auth: "service", input: z.object({ id: z.string() }), result: json(z.literal("ok")) }),
  };

  it("takes params first and a body last, per the declaration", async () => {
    const { fetch, calls } = replying(200, "ok");
    const client = createRouteClient(table, { fetch, token: "s3cret" });

    await client.plain();
    await client.remainder({ slug: "w", rest: "a.png" });
    await client.posted({ id: "x" });

    expect(calls.map((c) => c.url)).toEqual(["/api/health", "/worlds/w/a.png", "/api/thing"]);
    expect(calls[2]!.method).toBe("POST");
    expect(calls[2]!.headers?.["Content-Type"]).toBe("application/json");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer s3cret");
  });

  it("sends the revalidation headers only for a route that declares it", async () => {
    const { fetch, calls } = replying(200, []);
    const client = createRouteClient({ plain, worldManifest: worldManifestRoute }, { fetch });

    await client.plain();
    await client.worldManifest();

    expect(calls[0]!.headers?.["Cache-Control"]).toBeUndefined();
    expect(calls[1]!.headers?.["Cache-Control"]).toBe("no-cache");
  });

  it("hands a bytes route's body over whole, with nothing to parse", async () => {
    const { fetch } = replying(200, undefined);
    const got = await createRouteClient(table, { fetch }).remainder({ slug: "w", rest: "a.png" });
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
  });
});
