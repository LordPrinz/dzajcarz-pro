import type { Logger } from "@dzajcarz/core";
import { type BotClient, MAX_UPLOAD_BYTES } from "@dzajcarz/web-protocol";
import { type ArchiveRouteDeps, archiveRoutes } from "./archive.ts";
import type { AuditedResult, Auditor } from "./audit.ts";
import { createHealth, type Probes } from "./health.ts";
import { createGuard, guarded, guardRoutes } from "./http/guard.ts";
import { withSecurityHeaders } from "./http/headers.ts";
import { MAX_BODY_BYTES } from "./http/json.ts";
import { type PageFiles, pageRoutes } from "./http/page.ts";
import { BOT_TOPIC, createSubscriptions, type LiveState } from "./live.ts";
import { musicRoutes } from "./music.ts";
import { type ReadingRouteDeps, readingRoutes } from "./reading.ts";
import { type WritingRouteDeps, writingRoutes } from "./writing.ts";

/** Largest WebSocket message a client may send; the panel expects nothing bigger than a small JSON object. */
export const MAX_WS_MESSAGE_BYTES = 4 * 1024;
/**
 * Bytes Bun may queue for one socket before it closes it: a tab that stops reading (asleep, slow link) must
 * not make the server buffer every message event for it.
 */
export const WS_BACKPRESSURE_LIMIT = 1024 * 1024;

export interface WebServerDeps {
  publicOrigin: string;
  port: number;
  bot: Pick<BotClient, "request">;
  /** Every state-changing endpoint runs its action through `audited`. */
  auditor: Auditor;
  archiveSettings: ArchiveRouteDeps["archiveSettings"] & ReadingRouteDeps["archiveSettings"];
  archive: ReadingRouteDeps["archive"];
  uploads: WritingRouteDeps["uploads"];
  live: LiveState;
  probes: Probes;
  logger: Logger;
  /** The UI, from `loadPage`. */
  page: PageFiles;
}

type Routes = Record<string, unknown>;

/**
 * Bun rejects a bigger body before any handler runs. A file upload needs this much; every JSON route still
 * stops at `MAX_BODY_BYTES` in `readJson`.
 */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MAX_BODY_BYTES;

const isMethodMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Joins route tables; two tables with the same path add their methods to one map. The same method twice, or
 * a path that is a handler in one table and a method map in another, is a mistake and throws.
 */
export function mergeRoutes(...tables: Routes[]): Routes {
  const merged: Routes = {};
  for (const table of tables) {
    for (const [path, value] of Object.entries(table)) {
      const known = merged[path];
      if (known === undefined) {
        merged[path] = value;
        continue;
      }
      if (!isMethodMap(known) || !isMethodMap(value)) {
        throw new Error(`Route ${path} is defined twice and cannot be merged`);
      }
      const twice = Object.keys(value).filter((method) => Object.hasOwn(known, method));
      if (twice.length > 0) throw new Error(`Route ${path} defines ${twice.join(", ")} twice`);
      merged[path] = { ...known, ...value };
    }
  }
  return merged;
}

/** The HTTP answer for a bot (or audited) result that is not ok. */
export function failure(result: Extract<AuditedResult<unknown>, { ok: false }>): Response {
  switch (result.reason) {
    case "audit_unavailable":
      return Response.json({ error: "audit_unavailable" }, { status: 503 });
    case "unavailable":
      return Response.json({ error: "bot_unavailable" }, { status: 503 });
    case "timeout":
      return Response.json({ error: "bot_timeout" }, { status: 503 });
    case "error":
      return Response.json({ error: "bot_error" }, { status: 502 });
  }
}

/**
 * The `Bun.serve` options of the panel; the caller adds `port`, `hostname` and `development`, so tests can
 * start it on any port. Every route, the page included, goes through the guard (see `guardRoutes`), which
 * also adds the security headers.
 * `extraRoutes` is a test-only seam: it is merged before the guard, so it is guarded like the real routes.
 */
export function createWebServer(
  deps: WebServerDeps,
  { extraRoutes }: { extraRoutes?: Routes } = {},
) {
  const { bot, live, logger } = deps;
  const guard = createGuard({ publicOrigin: deps.publicOrigin, port: deps.port, logger });
  const health = createHealth(deps.probes);

  const listGuilds = async () => {
    const result = await bot.request("guilds.list", {});
    return result.ok ? Response.json({ guilds: result.data }) : failure(result);
  };
  const botStatus = () => {
    const { online, lastSeen } = live.status();
    return Response.json({
      bot: online ? "online" : "offline",
      lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    });
  };
  const readiness = async () => {
    const report = await health.check();
    return Response.json(report, { status: report.ok ? 200 : 503 });
  };
  const liveness = () => Response.json({ ok: true });
  // The page links its bundled icon; this answers browsers that ask for /favicon.ico anyway.
  const icon = [...deps.page].find(([path]) => path.startsWith("/favicon"))?.[1];
  const favicon = () =>
    icon
      ? new Response(icon.body, {
          headers: { "Content-Type": icon.type, "Cache-Control": "public, max-age=86400" },
        })
      : new Response(null, { status: 404 });
  const subscriptions = createSubscriptions();
  const upgrade = (request: Request, server: Bun.Server<undefined>) =>
    server.upgrade(request)
      ? undefined
      : Response.json({ error: "upgrade_failed" }, { status: 400 });

  const routes = guardRoutes(
    {
      ...pageRoutes(deps.page),
      "/api/guilds": { GET: listGuilds },
      "/api/status": { GET: botStatus },
      "/health": { GET: readiness },
      "/health/live": { GET: liveness },
      "/api/ws": { GET: upgrade },
      "/favicon.ico": { GET: favicon },
      ...archiveRoutes({
        bot,
        auditor: deps.auditor,
        archiveSettings: deps.archiveSettings,
        logger,
        failure,
      }),
      ...musicRoutes({ bot, auditor: deps.auditor, failure }),
      ...mergeRoutes(
        readingRoutes({
          bot,
          archive: deps.archive,
          archiveSettings: deps.archiveSettings,
          botOnline: () => live.status().online,
          logger,
          failure,
        }),
        writingRoutes({ bot, auditor: deps.auditor, uploads: deps.uploads, logger, failure }),
      ),
      ...extraRoutes,
    } satisfies Routes,
    guard,
  );

  return {
    routes,
    // Anything that matched no route; guarded too, so a probe cannot tell routes apart before the Host check.
    fetch: guarded(() => Response.json({ error: "not_found" }, { status: 404 }), guard),
    error(error: Error) {
      logger.error("Request failed", { error });
      return withSecurityHeaders(Response.json({ error: "internal_error" }, { status: 500 }));
    },
    maxRequestBodySize: MAX_REQUEST_BYTES,
    websocket: {
      // A bigger message closes the socket (1009).
      maxPayloadLength: MAX_WS_MESSAGE_BYTES,
      backpressureLimit: WS_BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      open(ws: Bun.ServerWebSocket<undefined>) {
        ws.subscribe(BOT_TOPIC);
        ws.send(JSON.stringify(live.status()));
      },
      // Subscribe and unsubscribe to one channel's message events or one server's music; anything else
      // closes the socket.
      message(ws: Bun.ServerWebSocket<undefined>, raw: string | Buffer) {
        subscriptions.handle(ws, raw);
      },
    },
  };
}
