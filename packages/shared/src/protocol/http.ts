// The shape of `fetch`, as this package is allowed to see it.
//
// @3d/shared is typechecked with `lib: ["ES2022"]` and `types: []`, so there is
// no `fetch`, `Response` or `RequestInit` type here at all. Rather than declare
// them in platform.d.ts, the types below say only what this package actually
// uses, and every caller injects its own host `fetch`:
//
//   createApiClient({ baseUrl, fetch: globalThis.fetch.bind(globalThis) })
//
// Three reasons that is better than declaring the global, before anyone
// "simplifies" it:
//
//   1. Declaring `fetch` means declaring `Response` and `RequestInit` too, and
//      platform.d.ts stops being a short, honest list of what we depend on.
//   2. A test can fake an HttpResponse with a plain object literal, which it
//      could not do with a nominal DOM type it has no lib for.
//   3. Hono's `app.request` satisfies HttpFetch, so a server-side test can run
//      the real routes in-process with no socket anywhere.
//
// Both the browser's `fetch` and Node's are assignable: their parameters are
// wider (contravariance) and `Response` has every member below.

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Browser-only semantics: Node accepts the field and ignores it, because it
   * has no HTTP cache. Code that needs revalidation on both ends sends a
   * `Cache-Control` header instead.
   */
  cache?: "no-store" | "no-cache";
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** How much of a failure's body is worth keeping. A refusal is a sentence; anything longer is a page, and not a message. */
const DETAIL_LIMIT = 200;

/** A request that reached the other end and came back as a failure. `status` is 0 when the request never arrived. */
export class HttpError extends Error {
  /**
   * What the provider said in the body, trimmed — Hono puts an HTTPException's
   * message here, which is the refusal in words rather than the status code's
   * guess at it. Empty when there was nothing to read. Callers should treat it
   * as prose only when it reads as prose: an api that answers a json error body
   * lands here too.
   */
  readonly detail: string;

  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    detail = "",
  ) {
    const said = detail.trim().slice(0, DETAIL_LIMIT);
    super(`${url}: ${status} ${statusText}${said ? ` — ${said}` : ""}`);
    this.name = "HttpError";
    this.detail = said;
  }
}
