import { afterEach, describe, expect, test } from "bun:test";
import type { BotClient, BotResult } from "@dzajcarz/web-protocol";
import type { AuditContext, Auditor } from "./audit.ts";
import { startTestServer, type TestServer } from "./testing.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

/** A bot that answers every request with `answer` and remembers what it was asked. */
function fakeBot(answer: (name: string, payload: unknown) => BotResult<unknown>) {
  const requests: [string, unknown][] = [];
  const bot = {
    request: async (name: string, payload: unknown) => {
      requests.push([name, payload]);
      return answer(name, payload);
    },
    onEvent: () => () => {},
  } as unknown as Pick<BotClient, "request" | "onEvent">;
  return { bot, requests };
}

/** An auditor that records each action, or refuses like one whose database is down. */
function recordingAuditor(available = true) {
  const audited: { action: string; context: AuditContext }[] = [];
  const auditor: Auditor = {
    async audited(_request, action, context, run) {
      audited.push({ action, context });
      if (!available) return { ok: false, reason: "audit_unavailable" };
      return run();
    },
  };
  return { auditor, audited };
}

const echo = (_name: string, payload: unknown): BotResult<unknown> => ({ ok: true, data: payload });

async function send(method: string, path: string, body: unknown) {
  if (!started) throw new Error("no server");
  return fetch(`${started.url}${path}`, {
    method,
    headers: { ...started.sameOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/archive/settings", () => {
  test("reads the settings from the database, without the bot", async () => {
    const { bot, requests } = fakeBot(echo);
    const guilds = [{ guildId: GUILD, enabled: true, excludedChannelIds: [CHANNEL] }];
    started = await startTestServer({
      bot,
      archiveSettings: { listGuilds: async () => guilds, dmEnabled: async () => true },
    });
    const response = await fetch(`${started.url}/api/archive/settings`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dm: { enabled: true }, guilds });
    expect(requests).toEqual([]);
  });

  test("503 when the database cannot be read", async () => {
    started = await startTestServer({
      archiveSettings: {
        listGuilds: async () => {
          throw new Error("down");
        },
        dmEnabled: async () => false,
      },
    });
    const response = await fetch(`${started.url}/api/archive/settings`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "database_unavailable" });
  });
});

describe("PUT /api/archive/guilds/:guildId", () => {
  test("is audited and sent to the bot with the guild from the path", async () => {
    const { bot, requests } = fakeBot(echo);
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const body = { enabled: true, excludedChannelIds: [CHANNEL] };
    const response = await send("PUT", `/api/archive/guilds/${GUILD}`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ guildId: GUILD, ...body });
    expect(audited).toEqual([
      { action: "archive.guild.set", context: { guildId: GUILD, payload: body } },
    ]);
    expect(requests).toEqual([["archive.guild.set", { guildId: GUILD, ...body }]]);
  });

  test.each([
    [
      "a guild id that is not one",
      "/api/archive/guilds/abc",
      { enabled: true, excludedChannelIds: [] },
    ],
    ["a missing switch", `/api/archive/guilds/${GUILD}`, { excludedChannelIds: [] }],
    [
      "a bad channel id",
      `/api/archive/guilds/${GUILD}`,
      { enabled: true, excludedChannelIds: ["x"] },
    ],
    [
      "an unknown key",
      `/api/archive/guilds/${GUILD}`,
      { enabled: true, excludedChannelIds: [], guildId: GUILD },
    ],
  ])("400 for %s, before any audit or bot call", async (_label, path, body) => {
    const { bot, requests } = fakeBot(echo);
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    expect((await send("PUT", path, body)).status).toBe(400);
    expect(audited).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("503 audit_unavailable and no bot call when the audit cannot be written", async () => {
    const { bot, requests } = fakeBot(echo);
    started = await startTestServer({ bot, auditor: recordingAuditor(false).auditor });
    const response = await send("PUT", `/api/archive/guilds/${GUILD}`, {
      enabled: false,
      excludedChannelIds: [],
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "audit_unavailable" });
    expect(requests).toEqual([]);
  });

  test("503 bot_unavailable when the bot is down", async () => {
    const { bot } = fakeBot(() => ({ ok: false, reason: "unavailable" }));
    started = await startTestServer({ bot });
    const response = await send("PUT", `/api/archive/guilds/${GUILD}`, {
      enabled: true,
      excludedChannelIds: [],
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "bot_unavailable" });
  });

  test("a request from another origin never reaches the handler", async () => {
    const { bot, requests } = fakeBot(echo);
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/archive/guilds/${GUILD}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ enabled: true, excludedChannelIds: [] }),
    });
    expect(response.status).toBe(403);
    expect(requests).toEqual([]);
  });
});

describe("PUT /api/archive/dm", () => {
  test("is audited and sent to the bot", async () => {
    const { bot, requests } = fakeBot(echo);
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await send("PUT", "/api/archive/dm", { enabled: true });
    expect(await response.json()).toEqual({ enabled: true });
    expect(audited).toEqual([
      { action: "archive.dm.set", context: { payload: { enabled: true } } },
    ]);
    expect(requests).toEqual([["archive.dm.set", { enabled: true }]]);
  });

  test("400 for a body without the switch", async () => {
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ auditor });
    expect((await send("PUT", "/api/archive/dm", { enabled: "tak" })).status).toBe(400);
    expect(audited).toEqual([]);
  });
});

describe("POST /api/archive/channels/:channelId/backfill", () => {
  test("is audited and answers what the bot stored", async () => {
    const result = { status: "ok", fetched: 100, stored: 40, oldestId: CHANNEL, done: false };
    const { bot, requests } = fakeBot(() => ({ ok: true, data: result }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await send("POST", `/api/archive/channels/${CHANNEL}/backfill`, {});
    expect(await response.json()).toEqual(result);
    expect(audited).toEqual([
      { action: "archive.backfill", context: { channelId: CHANNEL, payload: {} } },
    ]);
    expect(requests).toEqual([["archive.backfill", { channelId: CHANNEL }]]);
  });

  test("passes a starting point on and rejects a bad one", async () => {
    const { bot, requests } = fakeBot(() => ({ ok: true, data: { status: "not_archived" } }));
    started = await startTestServer({ bot });
    const before = "500000000000000001";
    await send("POST", `/api/archive/channels/${CHANNEL}/backfill`, { before });
    expect(requests).toEqual([["archive.backfill", { channelId: CHANNEL, before }]]);
    expect(
      (await send("POST", `/api/archive/channels/${CHANNEL}/backfill`, { before: "dawno" })).status,
    ).toBe(400);
    expect((await send("POST", "/api/archive/channels/nope/backfill", {})).status).toBe(400);
  });
});

describe("GET /api/guilds/:guildId/channels", () => {
  test("lists the channels the bot answers with", async () => {
    const data = {
      channels: [{ id: CHANNEL, name: "ogólny", kind: "text", parentId: null }],
      truncated: false,
    };
    const { bot, requests } = fakeBot(() => ({ ok: true, data }));
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/guilds/${GUILD}/channels`);
    expect(await response.json()).toEqual(data);
    expect(requests).toEqual([["guilds.channels", { guildId: GUILD }]]);
  });

  test("404 for a server the bot is not in and 400 for a bad id", async () => {
    const { bot } = fakeBot(() => ({ ok: true, data: null }));
    started = await startTestServer({ bot });
    const missing = await fetch(`${started.url}/api/guilds/${GUILD}/channels`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown_guild" });
    expect((await fetch(`${started.url}/api/guilds/abc/channels`)).status).toBe(400);
  });

  test("503 bot_timeout when the bot does not answer", async () => {
    const { bot } = fakeBot(() => ({ ok: false, reason: "timeout" }));
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/guilds/${GUILD}/channels`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
