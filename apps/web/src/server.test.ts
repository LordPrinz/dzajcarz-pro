import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryPubSub } from "@dzajcarz/kv";
import { createBotClient, createCommandServer, type GuildSummary } from "@dzajcarz/web-protocol";
import { commandHandlers } from "@dzajcarz/web-protocol/testing";
import { SECURITY_HEADERS } from "./http/headers.ts";
import { createLiveState } from "./live.ts";
import { failure, WS_BACKPRESSURE_LIMIT } from "./server.ts";
import {
  emptyArchive,
  PUBLIC_ORIGIN,
  startTestServer,
  type TestServer,
  testPage,
} from "./testing.ts";

const guilds: GuildSummary[] = [
  { id: "100000000000000001", name: "Alfa", iconUrl: null, memberCount: 3 },
];
const PUBLIC_HOST = "panel.example.com";
const STATUS = { guilds: 1, startedAt: "2026-11-11T10:00:00.000Z" };
const WATCHED = "200000000000000001";
const UNWATCHED = "200000000000000002";

const change = () => Response.json({ changed: true });
const boom = () => {
  throw new Error("secret detail");
};

let started: TestServer | undefined;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await started?.stop();
  started = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A real bot client talking to a command server over the memory pub/sub. */
async function withBot(handler: (() => Promise<GuildSummary[]>) | null, timeoutMs = 50) {
  const pubsub = createMemoryPubSub();
  const bot = createBotClient({ pubsub, timeoutMs, logger: silentLogger });
  await bot.start();
  if (handler) {
    const commands = createCommandServer({
      pubsub,
      logger: silentLogger,
      handlers: commandHandlers({ "guilds.list": handler }),
    });
    await commands.start();
    cleanups.push(() => commands.stop());
  }
  cleanups.push(() => bot.stop());
  return { bot, pubsub };
}

describe("GET /api/guilds", () => {
  test("lists the guilds the bot answers with", async () => {
    const { bot } = await withBot(async () => guilds);
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/guilds`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guilds });
  });

  test("503 bot_unavailable at once when no bot listens", async () => {
    const { bot } = await withBot(null, 3_000);
    started = await startTestServer({ bot });
    const began = Date.now();
    const response = await fetch(`${started.url}/api/guilds`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "bot_unavailable" });
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  test("503 bot_timeout when the bot receives the command and stays silent", async () => {
    const { bot, pubsub } = await withBot(null, 50);
    await pubsub.subscribe("dzajcarz:web:command", () => {});
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/guilds`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "bot_timeout" });
  });

  test("502 bot_error when the handler fails", async () => {
    const { bot } = await withBot(async () => {
      throw new Error("boom");
    });
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/guilds`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bot_error" });
  });
});

describe("other routes", () => {
  test("the page links its SVG icon, and /favicon.ico answers with it too", async () => {
    started = await startTestServer();
    const page = await (await fetch(`${started.url}/`)).text();
    const linked = /<link rel="icon" href="\.?(\/favicon-[^"]+\.svg)"/.exec(page)?.[1];
    expect(linked).toBeDefined();
    const icon = await fetch(`${started.url}${linked}`);
    const fallback = await fetch(`${started.url}/favicon.ico`);
    for (const response of [icon, fallback]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("image/svg+xml");
      expect(response.headers.get("content-security-policy")).toBe(
        SECURITY_HEADERS["Content-Security-Policy"] ?? "",
      );
    }
    expect(await fallback.text()).toBe(await icon.text());
  });

  test("an unknown path is 404 JSON", async () => {
    started = await startTestServer();
    const response = await fetch(`${started.url}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("/health is 200 when Postgres and Redis answer and 503 when one does not", async () => {
    started = await startTestServer();
    const up = await fetch(`${started.url}/health`);
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ ok: true, checks: { postgres: true, redis: true } });
    await started.stop();

    started = await startTestServer({
      probes: {
        postgres: async () => true,
        redis: async () => {
          throw new Error("down");
        },
      },
    });
    const down = await fetch(`${started.url}/health`);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, checks: { postgres: true, redis: false } });
  });

  test("/health does not depend on the bot, and /health/live always answers", async () => {
    const { bot } = await withBot(null);
    started = await startTestServer({ bot });
    expect((await fetch(`${started.url}/health`)).status).toBe(200);
    expect(await (await fetch(`${started.url}/health/live`)).json()).toEqual({ ok: true });
  });

  test("a route given through extraRoutes is guarded like the real ones", async () => {
    started = await startTestServer({
      extraRoutes: { "/api/change": { POST: change } },
    });
    const url = `${started.url}/api/change`;
    const json = { "Content-Type": "application/json" };
    expect(
      (await fetch(url, { method: "POST", headers: { ...json, Host: PUBLIC_HOST } })).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...json, Origin: PUBLIC_ORIGIN, Host: "evil.example" },
        })
      ).status,
    ).toBe(421);
    const accepted = await fetch(url, {
      method: "POST",
      headers: { ...json, ...started.sameOrigin },
      body: "{}",
    });
    expect(accepted.status).toBe(200);
  });

  test("a handler that throws is a 500 without details", async () => {
    started = await startTestServer({
      extraRoutes: { "/api/boom": { GET: boom } },
    });
    const response = await fetch(`${started.url}/api/boom`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });

  test("/ serves the page with its root element", async () => {
    started = await startTestServer();
    const response = await fetch(`${started.url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });
});

describe("security headers", () => {
  const expectSecurityHeaders = (response: Response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  };

  test("the CSP allows only the page's own origin, and Discord's media hosts for images and video", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe(
      "default-src 'self'; " +
        "img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; " +
        "media-src https://cdn.discordapp.com https://media.discordapp.net; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });

  test("the page and every asset it links carry them", async () => {
    started = await startTestServer();
    const page = await fetch(`${started.url}/`);
    expectSecurityHeaders(page);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const assets = [...(await page.text()).matchAll(/(?:src|href)="\.?(\/[^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      const response = await fetch(`${started.url}${asset}`);
      expect(response.status).toBe(200);
      expectSecurityHeaders(response);
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
  });

  test("a matching ETag is a 304, still with the headers", async () => {
    started = await startTestServer();
    const etag = (await fetch(`${started.url}/`)).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const again = await fetch(`${started.url}/`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expectSecurityHeaders(again);
  });

  test.each([
    ["a list", (etag: string) => `"other", ${etag}`],
    ["a weak tag", (etag: string) => `W/${etag}`],
    ["a wildcard", () => "*"],
  ])("If-None-Match with %s is a 304", async (_label, header) => {
    started = await startTestServer();
    const etag = (await fetch(`${started.url}/`)).headers.get("etag") ?? "";
    const again = await fetch(`${started.url}/`, { headers: { "If-None-Match": header(etag) } });
    expect(again.status).toBe(304);
  });

  test("If-None-Match without the current tag gets the page", async () => {
    started = await startTestServer();
    const again = await fetch(`${started.url}/`, {
      headers: { "If-None-Match": '"old", W/"older"' },
    });
    expect(again.status).toBe(200);
  });

  test.each([
    ["the guild list", "/api/guilds", {}],
    ["the bot status", "/api/status", {}],
    ["readiness", "/health", {}],
    ["liveness", "/health/live", {}],
    ["a 404", "/nope", {}],
    ["a 421", "/api/status", { Host: "evil.example" }],
    ["a 500", "/api/boom", {}],
  ])("%s is never cached", async (_label, path, headers) => {
    started = await startTestServer({ extraRoutes: { "/api/boom": { GET: boom } } });
    const response = await fetch(`${started.url}${path}`, { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("HEAD on the page answers its headers without a body", async () => {
    started = await startTestServer();
    const get = await fetch(`${started.url}/`);
    const body = await get.arrayBuffer();
    const head = await fetch(`${started.url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expectSecurityHeaders(head);
  });

  test.each([
    ["an API answer", "/api/status", {}, 200],
    ["a 404", "/nope", {}, 404],
    ["a 421", "/api/status", { Host: "evil.example" }, 421],
    ["a 403", "/api/change", { Host: PUBLIC_HOST }, 403],
    ["a 500", "/api/boom", {}, 500],
  ])("%s carries them", async (_label, path, headers, status) => {
    started = await startTestServer({
      extraRoutes: { "/api/change": { POST: change }, "/api/boom": { GET: boom } },
    });
    const response = await fetch(`${started.url}${path}`, {
      method: path === "/api/change" ? "POST" : "GET",
      headers,
    });
    expect(response.status).toBe(status);
    expectSecurityHeaders(response);
  });
});

describe("failure", () => {
  test.each([
    [{ ok: false, reason: "audit_unavailable" } as const, 503, "audit_unavailable"],
    [{ ok: false, reason: "unavailable" } as const, 503, "bot_unavailable"],
    [{ ok: false, reason: "timeout" } as const, 503, "bot_timeout"],
    [{ ok: false, reason: "error", message: "secret" } as const, 502, "bot_error"],
  ])("%p is %d %s", async (result, status, error) => {
    const response = failure(result);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });
});

describe("GET /api/status", () => {
  test("is online for a heartbeat 10 s old and offline at 45 s", async () => {
    let clock = 1_000_000;
    const live = createLiveState(() => clock);
    started = await startTestServer({ live });
    const status = async () =>
      (await (await fetch(`${started?.url}/api/status`)).json()) as {
        bot: string;
        lastSeen: string | null;
      };

    expect(await status()).toEqual({ bot: "offline", lastSeen: null });
    live.record(STATUS);
    clock += 10_000;
    expect((await status()).bot).toBe("online");
    clock += 35_000;
    const stale = await status();
    expect(stale.bot).toBe("offline");
    expect(stale.lastSeen).toBe(new Date(1_000_000).toISOString());
  });
});

describe("WebSocket /api/ws", () => {
  function open(t: TestServer, headers: Record<string, string>) {
    const socket = new WebSocket(`ws://127.0.0.1:${t.port}/api/ws`, { headers } as never);
    const messages: Record<string, unknown>[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("socket error"));
    });
    return { socket, messages, opened };
  }

  async function until(condition: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  }

  test("a socket with the right Host and Origin gets the cached status and later heartbeats", async () => {
    const pubsub = createMemoryPubSub();
    const bot = createBotClient({ pubsub, timeoutMs: 50, logger: silentLogger });
    await bot.start();
    cleanups.push(() => bot.stop());
    const commands = createCommandServer({
      pubsub,
      logger: silentLogger,
      handlers: commandHandlers({ "guilds.list": async () => [] }),
    });
    started = await startTestServer({ bot });
    await commands.publishEvent("bot.status", STATUS);

    const { socket, messages, opened } = open(started, {
      Origin: PUBLIC_ORIGIN,
      Host: PUBLIC_HOST,
    });
    await opened;
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ event: "bot.status", online: true, payload: STATUS });

    await commands.publishEvent("bot.status", { guilds: 5, startedAt: STATUS.startedAt });
    await until(() => messages.length === 2);
    expect(messages[1]).toMatchObject({ payload: { guilds: 5 } });

    // Anything but a valid subscribe or unsubscribe closes the socket.
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.send("subscribe everything");
    expect(await closed).toBe(1008);
  });

  test("message events reach only the sockets watching their channel", async () => {
    const pubsub = createMemoryPubSub();
    const bot = createBotClient({ pubsub, timeoutMs: 50, logger: silentLogger });
    await bot.start();
    cleanups.push(() => bot.stop());
    const commands = createCommandServer({
      pubsub,
      logger: silentLogger,
      handlers: commandHandlers(),
    });
    started = await startTestServer({ bot });
    const watching = open(started, { Origin: PUBLIC_ORIGIN, Host: PUBLIC_HOST });
    const other = open(started, { Origin: PUBLIC_ORIGIN, Host: PUBLIC_HOST });
    await Promise.all([watching.opened, other.opened]);
    await until(() => watching.messages.length === 1 && other.messages.length === 1);
    watching.socket.send(JSON.stringify({ type: "subscribe", channelId: WATCHED }));
    other.socket.send(JSON.stringify({ type: "subscribe", channelId: UNWATCHED }));
    await Bun.sleep(30);

    const deleted = (channelId: string) =>
      commands.publishEvent("message.deleted", { guildId: null, channelId, ids: [WATCHED] });
    await deleted(WATCHED);
    await until(() => watching.messages.length === 2);
    expect(watching.messages[1]).toEqual({
      event: "message.deleted",
      payload: { guildId: null, channelId: WATCHED, ids: [WATCHED] },
    });
    await Bun.sleep(30);
    expect(other.messages).toHaveLength(1);

    watching.socket.send(JSON.stringify({ type: "unsubscribe", channelId: WATCHED }));
    await Bun.sleep(30);
    await deleted(WATCHED);
    await Bun.sleep(30);
    expect(watching.messages).toHaveLength(2);
    watching.socket.close();
    other.socket.close();
  });

  test("the socket settings close a client that stops reading", async () => {
    started = await startTestServer();
    const { websocket } = (await import("./server.ts")).createWebServer({
      publicOrigin: PUBLIC_ORIGIN,
      port: 1,
      bot: { request: async () => ({ ok: false as const, reason: "unavailable" as const }) },
      auditor: { audited: (_request, _action, _context, run) => run() },
      archiveSettings: {
        listGuilds: async () => [],
        dmEnabled: async () => false,
        findGuild: async () => null,
      },
      archive: emptyArchive,
      live: started.live,
      probes: { postgres: async () => true, redis: async () => true },
      logger: silentLogger,
      page: await testPage(),
    });
    expect(websocket.backpressureLimit).toBe(WS_BACKPRESSURE_LIMIT);
    expect(websocket.closeOnBackpressureLimit).toBe(true);
  });

  test("a fresh page with no heartbeat yet sees an offline status", async () => {
    started = await startTestServer();
    const { socket, messages, opened } = open(started, {
      Origin: PUBLIC_ORIGIN,
      Host: PUBLIC_HOST,
    });
    await opened;
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ online: false, payload: null, lastSeen: null });
    socket.close();
  });

  test("a message over 4 KB closes the socket", async () => {
    started = await startTestServer();
    const { socket, opened } = open(started, { Origin: PUBLIC_ORIGIN, Host: PUBLIC_HOST });
    await opened;
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.send("x".repeat(4 * 1024 + 1));
    expect(await closed).toBe(1009);
  });

  test("a socket with a wrong Origin never opens", async () => {
    started = await startTestServer();
    const { opened } = open(started, { Origin: "https://evil.example", Host: PUBLIC_HOST });
    await expect(opened).rejects.toThrow();
  });
});
