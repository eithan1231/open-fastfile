// What a route is, as data, and the one mechanism over it.
//
// A route is declared once — method, path, who may call it, what goes up, what
// comes back — and both ends are built from that declaration: protocol/api.ts
// turns the table into a typed client, and @3d/api's routes/mount.ts mounts the
// same entries on Hono. Neither end writes a URL, a method or a schema of its
// own, so a route cannot be changed at one end only. Adding one is a file under
// routes/ and a line in the table; nothing else has to be told.
//
// The layering is net/'s, for the same reason: the mechanism here, the
// descriptions in routes/, and protocol/api.ts as the entry point that names
// them. Nothing in this file knows a single route of this api.
//
// -- Paths -------------------------------------------------------------------
//
// `:name` is one path segment and a trailing `*` is the remainder, which arrives
// as a param called `rest`. `routePath` builds a URL out of params and
// `matchRoutePath` takes one apart again; they are inverses built from one
// tokenizer, because a builder that disagrees with its matcher is a 404 nobody
// can read.
//
// Params are strings in both directions, and a params schema *refuses* a value
// rather than converting one. A route that wants a number declares
// `z.string().regex(/^\d+$/)` and its handler converts, which keeps one type for
// `:page` at both ends instead of two that have to agree.
//
// Two things this deliberately does not do. There is no query-string slot yet —
// no route needs one, and the day one does it belongs here beside `input` rather
// than hand-parsed in a handler. And the client does not check params against
// the schema before sending: a caller that builds a path the contract refuses
// should get a 404 it can report, not a throw from inside the client. The schema
// is the provider's refusal.

// zod/mini, not zod: a route's schemas are built at module load, so the client
// cannot tree-shake the ones it never calls — classic cost +24 KB gzip in the
// browser, mini +6 KB. Hence `.check(z.minLength(1))` rather than `.min(1)`, and
// terser failures. docs/server/README.md has the measurements.
import type * as z from "zod/mini";
import { HttpError, type HttpFetch } from "./http.js";

export type HttpMethod = "GET" | "POST";

/**
 * Who may call a route. `service` is the fleet's own surface: the caller presents
 * the service token and a browser never does. `user` is a signed-in player,
 * carrying their session. The provider applies it from here, so a route's
 * audience is part of its declaration rather than a middleware grouping somebody
 * has to remember to mount it under.
 */
export type RouteAuth = "public" | "service" | "user";

export interface JsonBody<T> {
  readonly kind: "json";
  readonly schema: z.ZodMiniType<T>;
}

/** Bytes, for a route whose body is a file: the client gets them whole, and the provider owns the Response so it can stream. */
export interface BytesBody {
  readonly kind: "bytes";
}

/**
 * An open stream of events (SSE), rather than one answer. The schema is what
 * both ends serialize and parse each event through, so a stream is as declared
 * as a request/response route is — but the transport is each host's own, because
 * a browser has EventSource and a Node process has neither that nor a reason to
 * pretend it does.
 */
export interface EventsBody<T> {
  readonly kind: "events";
  readonly event: z.ZodMiniType<T>;
}

export type RouteResult<T> = JsonBody<T> | BytesBody | EventsBody<T>;

export const json = <T>(schema: z.ZodMiniType<T>): JsonBody<T> => ({ kind: "json", schema });

export const bytes = (): BytesBody => ({ kind: "bytes" });

export const events = <T>(event: z.ZodMiniType<T>): EventsBody<T> => ({ kind: "events", event });

/** The param a trailing `*` arrives as. */
export const REST_PARAM = "rest";

type Simplify<T> = { [K in keyof T]: T[K] };

/** The name `:slug` and `:slug.json` both declare. A literal suffix ends a param. */
type ParamName<S extends string> = S extends `${infer Name}.${string}` ? Name : S;

type SegmentParams<Path extends string> = Path extends `${string}:${infer Tail}`
  ? Tail extends `${infer Segment}/${infer Rest}`
    ? Record<ParamName<Segment>, string> & SegmentParams<Rest>
    : Record<ParamName<Tail>, string>
  : object;

type RestParam<Path extends string> = Path extends `${string}*` ? { rest: string } : object;

/** The params a path declares, read off the path itself. `/worlds/:slug/*` is `{ slug: string; rest: string }`. */
export type ParamsOf<Path extends string> = Simplify<SegmentParams<Path> & RestParam<Path>>;

type HasParams<Path extends string> = keyof ParamsOf<Path> extends never ? false : true;

export interface Route<Path extends string, Input, Result> {
  readonly method: HttpMethod;
  readonly path: Path;
  readonly auth: RouteAuth;
  /** Checked by the provider against the values it parsed out of the URL. Optional: a path with no params needs none. */
  readonly params?: z.ZodMiniType<ParamsOf<Path>>;
  /** The request body. Absent means there is none, which is what makes a client method take no argument for it. */
  readonly input?: z.ZodMiniType<Input>;
  readonly result: Result;
  /** Send cache-busting headers and answer from the origin. For anything a re-export can change under the caller. */
  readonly revalidate: boolean;
}

/** Every route erases to this. The `unknown`s are sound: the mechanism only ever parses through these schemas. */
export type AnyRoute = Route<string, unknown, RouteResult<unknown>>;

export type RouteTable = Record<string, AnyRoute>;

export type OutputOf<R extends AnyRoute> = R["result"] extends JsonBody<infer T> ? T : Uint8Array;

export type InputOf<R extends AnyRoute> = R extends Route<string, infer I, RouteResult<unknown>> ? I : never;

export function defineRoute<Path extends string, Result extends RouteResult<unknown>, Input = undefined>(spec: {
  method: HttpMethod;
  path: Path;
  auth: RouteAuth;
  params?: z.ZodMiniType<ParamsOf<Path>>;
  input?: z.ZodMiniType<Input>;
  result: Result;
  revalidate?: boolean;
}): Route<Path, Input, Result> {
  return {
    method: spec.method,
    path: spec.path,
    auth: spec.auth,
    params: spec.params,
    input: spec.input,
    result: spec.result,
    revalidate: spec.revalidate ?? false,
  };
}

// -- Paths: one tokenizer, a builder and its inverse -------------------------

type PathToken = { readonly literal: string } | { readonly param: string };

const PARAM_PATTERN = /:([A-Za-z0-9_]+)|\*/g;

function tokenize(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const pattern = new RegExp(PARAM_PATTERN);
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    if (match.index > at) {
      tokens.push({ literal: path.slice(at, match.index) });
    }
    tokens.push({ param: match[1] ?? REST_PARAM });
    at = match.index + match[0].length;
  }
  if (at < path.length) {
    tokens.push({ literal: path.slice(at) });
  }
  return tokens;
}

/** The same rule `HasParams` states in the type system, for the places that only have the string. */
export const hasPathParams = (path: string): boolean => /[:*]/.test(path);

function buildPath(path: string, params: Record<string, string>): string {
  let out = "";
  for (const token of tokenize(path)) {
    if ("literal" in token) {
      out += token.literal;
      continue;
    }
    const value = params[token.param];
    if (value === undefined) {
      throw new Error(`${path}: no value for path param "${token.param}"`);
    }
    // A segment is encoded; the remainder is already a path and keeps its slashes.
    out += token.param === REST_PARAM ? value : encodeURIComponent(value);
  }
  return out;
}

/** A route's params as its tuple of arguments: present when the path declares any, absent when it does not. */
export type ParamsArgs<Path extends string> = HasParams<Path> extends true ? [params: ParamsOf<Path>] : [];

/** The URL a route lives at. The one way either end spells one. */
export function routePath<R extends AnyRoute>(route: R, ...args: ParamsArgs<R["path"]>): string {
  return buildPath(route.path, (args[0] ?? {}) as Record<string, string>);
}

const escapeLiteral = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The params in a request's path, or undefined if it is not this route's path at
 * all. A provider answers that case 404: a URL the contract cannot name names no
 * resource.
 *
 * Values are decoded here, once more than the host router already has. That is
 * what turns `%2e%2e%2f` into `../`, which is the form an encoded traversal
 * arrives in and the only form a path guard can refuse — see @3d/api's
 * src/worlds/paths.ts. Malformed percent-encoding is not a path either, so it
 * comes back undefined rather than throwing out of the handler.
 */
export function matchRoutePath<R extends AnyRoute>(route: R, path: string): ParamsOf<R["path"]> | undefined {
  const tokens = tokenize(route.path);
  const names: string[] = [];
  let pattern = "";
  for (const token of tokens) {
    if ("literal" in token) {
      pattern += escapeLiteral(token.literal);
    } else {
      names.push(token.param);
      pattern += token.param === REST_PARAM ? "(.*)" : "([^/]+)";
    }
  }

  const match = new RegExp(`^${pattern}$`).exec(path);
  if (!match) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    const raw = match[index + 1] ?? "";
    try {
      params[name] = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return params as ParamsOf<R["path"]>;
}

// -- The client --------------------------------------------------------------

/** A route's arguments: its params first when the path declares any, its body last when it has one. */
export type RouteArgs<R extends AnyRoute> = [...ParamsArgs<R["path"]>, ...(InputOf<R> extends undefined ? [] : [body: InputOf<R>])];

/**
 * A method per route — except an `events` one, whose key is removed. A stream is
 * not a request/response, and a generated method for it would buffer until the
 * stream closed, which is never. Each host opens those itself; what it shares
 * with the other end is the declaration's event schema, not this client.
 *
 * `"events" extends …` rather than the reverse so that the erased `RouteTable`
 * case (`kind` widened to the whole union) drops the key rather than keeping a
 * method that would hang.
 */
export type RouteClient<T extends RouteTable> = {
  [K in keyof T as "events" extends T[K]["result"]["kind"] ? never : K]: (...args: RouteArgs<T[K]>) => Promise<OutputOf<T[K]>>;
};

export interface RouteClientOptions {
  /** Where the api is. Empty (the default) means same-origin, which is what the browser wants. No trailing slash. */
  baseUrl?: string;
  /** The host's fetch. See ./http.ts for why this is injected rather than reached for. */
  fetch: HttpFetch;
  /** A service token, for a caller that is not a browser carrying a user's session. */
  token?: string;
}

/**
 * A parse failure as one line: which field, and what was wrong with it. Both ends
 * report through this. It takes the issues rather than the error object, so that
 * nothing here has to name a zod type: a path and a message are all a reader of
 * the message needs.
 */
export const describeIssues = (issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string =>
  issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

/**
 * A method per route, each parsing what comes back.
 *
 * The parse is what these wrappers buy over a bare fetch: a response that has
 * drifted from the contract fails here, naming the field, rather than three
 * layers deeper as an `undefined`. The one exception is a `bytes` route, which
 * has nothing to parse, and WorldPayload, which says in its own declaration why
 * it is guarded by shape instead.
 */
export function createRouteClient<T extends RouteTable>(routes: T, { baseUrl = "", fetch, token }: RouteClientOptions): RouteClient<T> {
  const send = async (route: AnyRoute, params: Record<string, string>, body: unknown): Promise<unknown> => {
    const url = baseUrl + buildPath(route.path, params);

    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (route.revalidate) {
      // `cache` is the browser's lever and `Cache-Control` the one Node's fetch
      // respects, so send both and let each host ignore the other.
      headers["Cache-Control"] = "no-cache";
    }

    const res = await fetch(url, {
      method: route.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(route.revalidate ? { cache: "no-store" as const } : {}),
    });
    if (!res.ok) {
      // The body too: a refusal this api can express in words ("no server for
      // that map") is written there, and a status code alone cannot be shown to
      // anyone. Unreadable is not a second failure — it just leaves it empty.
      throw new HttpError(url, res.status, res.statusText, await res.text().catch(() => ""));
    }

    if (route.result.kind === "bytes") {
      return new Uint8Array(await res.arrayBuffer());
    }
    if (route.result.kind === "events") {
      // Unreachable: RouteClient drops the key and the loop below builds no
      // method for it. Here so that adding a fourth kind cannot land silently.
      throw new Error(`${url}: an events route has no client method — open the stream with the host's own reader.`);
    }
    const parsed = route.result.schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`${url}: unexpected response — ${describeIssues(parsed.error.issues)}`);
    }
    return parsed.data;
  };

  const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, route] of Object.entries(routes)) {
    // The same rule RouteClient states in the type system.
    if (route.result.kind === "events") {
      continue;
    }
    // The same rule RouteArgs states in the type system.
    const takesParams = hasPathParams(route.path);
    client[name] = (...args) =>
      send(route, takesParams ? (args[0] as Record<string, string>) : {}, route.input === undefined ? undefined : args[takesParams ? 1 : 0]);
  }
  return client as unknown as RouteClient<T>;
}
