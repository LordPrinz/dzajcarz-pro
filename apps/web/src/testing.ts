import { silentLogger } from "@dzajcarz/core";
import type { ArchiveReader } from "@dzajcarz/db";
import type { BotClient } from "@dzajcarz/web-protocol";
import { loadPage, type PageFiles } from "./http/page.ts";
import { attachLive, createLiveState, type LiveState } from "./live.ts";
import { createWebServer, type WebServerDeps } from "./server.ts";

export const PUBLIC_ORIGIN = "https://panel.example.com";

/** An archive with nothing in it. */
export const emptyArchive: ArchiveReader = {
  page: async () => ({ messages: [], hasOlder: false, hasNewer: false }),
  channelGuild: async () => undefined,
  messagePlace: async () => null,
  versions: async () => [],
  search: async () => ({ messages: [], hasMore: false }),
  authorNames: async () => new Map(),
  dmChannels: async () => [],
};

let page: Promise<PageFiles> | undefined;
/** The built page, once per test run: building it takes a moment. */
export const testPage = (): Promise<PageFiles> => {
  page ??= loadPage();
  return page;
};

/** A port nobody holds right now. The guard needs to know it before the server starts. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  return port ?? 0;
}

export interface TestServer {
  server: Bun.Server<undefined>;
  port: number;
  live: LiveState;
  /** `http://127.0.0.1:<port>`; its Host (`127.0.0.1:<port>`) passes the guard. */
  url: string;
  /** A request init the guard accepts for a state-changing call. */
  sameOrigin: { Origin: string; Host: string };
  stop(): Promise<void>;
}

export async function startTestServer(
  overrides: Partial<WebServerDeps> & {
    extraRoutes?: Record<string, unknown>;
    bot?: Pick<BotClient, "request" | "onEvent">;
  } = {},
): Promise<TestServer> {
  const port = await freePort();
  const live = overrides.live ?? createLiveState();
  const bot = overrides.bot ?? {
    request: async () => ({ ok: true as const, data: [] as never }),
    onEvent: () => () => {},
  };
  const { extraRoutes, ...deps } = overrides;
  const options = createWebServer(
    {
      publicOrigin: PUBLIC_ORIGIN,
      port,
      live,
      // Runs the action without recording it; the auditor has its own tests.
      auditor: { audited: (_request, _action, _context, run) => run() },
      archiveSettings: {
        listGuilds: async () => [],
        dmEnabled: async () => false,
        findGuild: async () => null,
      },
      archive: emptyArchive,
      probes: { postgres: async () => true, redis: async () => true },
      logger: silentLogger,
      page: await testPage(),
      ...deps,
      bot,
    },
    { extraRoutes },
  );
  const server = Bun.serve({ ...options, port, hostname: "127.0.0.1" });
  const detach = attachLive(server, bot, live);
  return {
    server,
    port,
    live,
    url: `http://127.0.0.1:${port}`,
    sameOrigin: { Origin: PUBLIC_ORIGIN, Host: new URL(PUBLIC_ORIGIN).host },
    async stop() {
      detach();
      await server.stop(true);
    },
  };
}
