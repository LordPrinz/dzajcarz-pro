import type { Logger } from "@dzajcarz/core";
import { withSecurityHeaders } from "./headers.ts";

/** Set on every handler `guarded` returns, so a test can tell a wrapped handler from a bare one. */
export const GUARDED = Symbol("guarded");
/** Set by `binaryBody` on the one kind of handler that takes a raw file instead of JSON. */
const BINARY_BODY = Symbol("binary-body");

export interface GuardConfig {
  /** `WEB_PUBLIC_ORIGIN`: a bare origin. */
  publicOrigin: string;
  /** `WEB_PORT`, for the loopback names the container's own healthcheck uses. */
  port: number;
  logger: Logger;
}

export interface Guard {
  hosts: ReadonlySet<string>;
  /** The port a Host may leave out: 443 for an https public origin, 80 for http. */
  defaultPort: string;
  origin: string;
  logger: Logger;
}

type Handler = (
  request: Request,
  server: Bun.Server<undefined>,
) => Response | undefined | Promise<Response | undefined>;
type GuardedHandler = Handler & { [GUARDED]?: true };
type MarkedHandler = Handler & { [BINARY_BODY]?: true };

/** The body type a route takes: JSON unless the handler is marked with `binaryBody`. */
export type BodyType = "json" | "binary";

const BODY_TYPES: Record<BodyType, string> = {
  json: "application/json",
  binary: "application/octet-stream",
};

/**
 * Marks a handler that takes a raw file (`application/octet-stream`) and nothing else. Like JSON, that type
 * is not one a cross-site form can send, and the Origin and Host checks apply as to every route.
 */
export function binaryBody(handler: Handler): Handler {
  const marked: MarkedHandler = (request, server) => handler(request, server);
  marked[BINARY_BODY] = true;
  return marked;
}

const defaultPortOf = (publicOrigin: string) =>
  new URL(publicOrigin).protocol === "https:" ? "443" : "80";

/**
 * A `Host` value in the form the allow-list uses: lower case, without the one trailing dot of a fully
 * qualified name, and without the port when it is `defaultPort`. Anything else stays as it is and fails.
 */
export function normalizeHost(host: string, defaultPort: string): string {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d+))?$/.exec(host.toLowerCase());
  if (!match) return host;
  const [, rawName = "", port] = match;
  const name = rawName.endsWith(".") ? rawName.slice(0, -1) : rawName;
  return port === undefined || port === defaultPort ? name : `${name}:${port}`;
}

/** Public host plus the loopback names, so `web healthcheck` inside the container passes. */
export function allowedHosts({ publicOrigin, port }: Pick<GuardConfig, "publicOrigin" | "port">) {
  const defaultPort = defaultPortOf(publicOrigin);
  return new Set(
    [new URL(publicOrigin).host, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].map(
      (host) => normalizeHost(host, defaultPort),
    ),
  );
}

export function createGuard(config: GuardConfig): Guard {
  return {
    hosts: allowedHosts(config),
    defaultPort: defaultPortOf(config.publicOrigin),
    origin: new URL(config.publicOrigin).origin,
    logger: config.logger,
  };
}

export const isSafeMethod = (method: string): boolean =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const reject = (status: number, error: string) => Response.json({ error }, { status });

/**
 * The checks every API, WebSocket and health request goes through (ADR 9):
 * - `Host` must be the public host or a loopback name (421), against DNS rebinding;
 * - state-changing requests and WebSocket upgrades need an exact `Origin` (403), against cross-site requests;
 * - a body on a state-changing request must be JSON (415), which also blocks HTML form posts; a route marked
 *   with `binaryBody` takes `application/octet-stream` instead, and then only that.
 * Returns the rejection, or undefined when the request may go on.
 */
export function check(
  guard: Guard,
  request: Request,
  bodyType: BodyType = "json",
): Response | undefined {
  const host = request.headers.get("host") ?? "";
  if (!guard.hosts.has(normalizeHost(host, guard.defaultPort))) {
    guard.logger.warn("Rejected a request with an unexpected Host", { host, path: request.url });
    return reject(421, "misdirected_request");
  }
  const unsafe = !isSafeMethod(request.method);
  if (unsafe || isWebSocketUpgrade(request)) {
    const origin = request.headers.get("origin");
    if (origin !== guard.origin) {
      guard.logger.warn("Rejected a request with a foreign or missing Origin", {
        origin,
        method: request.method,
      });
      return reject(403, "forbidden_origin");
    }
  }
  if (unsafe && request.body !== null) {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== BODY_TYPES[bodyType]) return reject(415, "unsupported_media_type");
  }
  return undefined;
}

/** Wraps one handler in the checks and adds the security headers to whatever it answers. */
export function guarded(handler: Handler, guard: Guard): GuardedHandler {
  const bodyType: BodyType = (handler as MarkedHandler)[BINARY_BODY] ? "binary" : "json";
  const wrapped: GuardedHandler = async (request, server) => {
    const response = check(guard, request, bodyType) ?? (await handler(request, server));
    // undefined: the request became a WebSocket.
    return response && withSecurityHeaders(response);
  };
  wrapped[GUARDED] = true;
  return wrapped;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const isMethodMap = (value: object): value is Record<string, unknown> =>
  Object.keys(value).length > 0 && Object.keys(value).every((key) => METHODS.has(key));

/**
 * Bun's `routes` has no middleware, so the guard is applied by construction: every function route and every
 * per-method handler is wrapped. The page is served by plain handlers too (`pageRoutes`), so nothing is left
 * out; a value that is not a function would stay as it is.
 */
export function guardRoutes<T extends Record<string, unknown>>(routes: T, guard: Guard): T {
  const wrap = (value: unknown): unknown => {
    if (typeof value === "function") return guarded(value as Handler, guard);
    if (value !== null && typeof value === "object" && isMethodMap(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([method, handler]) => [method, wrap(handler)]),
      );
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(routes).map(([path, value]) => [path, wrap(value)]),
  ) as T;
}
