// Serving the built client, which the api does in production so that the page,
// the worlds and /api/* all come from one origin — and so there is no CORS.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testApp } from "../testing/app.js";

let dist: string;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "client-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>3D Designer</title>");
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");
});

afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

const app = () => testApp({ clientDist: dist }).app;

describe("serving the client", () => {
  it("serves index.html at the root", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("3D Designer");
  });

  it("serves a fingerprinted asset as immutable, and the document as not", async () => {
    const asset = await app().request("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toContain("immutable");

    // A cached entry document means a deploy is invisible until a hard reload.
    const doc = await app().request("/");
    expect(doc.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("falls back to index.html, so a pose link loads", async () => {
    const res = await app().request("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("3D Designer");
  });

  it("never shadows a route above it", async () => {
    // The fallback matches "/*", so it would swallow everything if it were
    // mounted first.
    expect((await app().request("/api/health")).status).toBe(200);
    expect((await app().request("/worlds-manifest.json")).headers.get("Content-Type")).toContain("application/json");
  });

  it("does not serve files above the bundle", async () => {
    const res = await app().request("/%2e%2e/%2e%2e/package.json");
    // The fallback answers instead — what matters is that it is not the file.
    const body = await res.text();
    expect(body).not.toContain('"name"');
    expect(body).toContain("3D Designer");
  });

  it("404s when there is no build at all", async () => {
    const none = testApp().app;
    expect((await none.request("/")).status).toBe(404);
  });
});
