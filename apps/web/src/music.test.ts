import { afterEach, describe, expect, test } from "bun:test";
import { type BotClient, type BotResult, SLOW_MUSIC_TIMEOUT_MS } from "@dzajcarz/web-protocol";
import type { AuditContext, Auditor } from "./audit.ts";
import { startTestServer, type TestServer } from "./testing.ts";

const GUILD = "100000000000000001";
const VOICE = "400000000000000004";
const SEARCH = "8b0f3c1e-1d2a-4f5b-9c6d-7e8f9a0b1c2d";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

function fakeBot(answer: (name: string, payload: unknown) => BotResult<unknown>) {
  const requests: { name: string; payload: unknown; options?: unknown }[] = [];
  const bot = {
    request: async (name: string, payload: unknown, options?: unknown) => {
      requests.push(options === undefined ? { name, payload } : { name, payload, options });
      return answer(name, payload);
    },
    onEvent: () => () => {},
  } as unknown as Pick<BotClient, "request" | "onEvent">;
  return { bot, requests };
}

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

const answering = (data: unknown) => (): BotResult<unknown> => ({ ok: true, data });
const SLOW = { timeoutMs: SLOW_MUSIC_TIMEOUT_MS };

async function call(method: string, path: string, body?: unknown) {
  if (!started) throw new Error("no server");
  return fetch(`${started.url}${path}`, {
    method,
    headers: { ...started.sameOrigin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("music reads", () => {
  test("the state asks the bot for the page and is not audited", async () => {
    const snapshot = {
      guildId: GUILD,
      available: true,
      at: new Date().toISOString(),
      player: null,
    };
    const { bot, requests } = fakeBot(answering(snapshot));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("GET", `/api/music/${GUILD}/state?offset=20`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(requests).toEqual([{ name: "music.state", payload: { guildId: GUILD, offset: 20 } }]);
    expect(audited).toEqual([]);
    expect((await call("GET", `/api/music/${GUILD}/state?offset=-1`)).status).toBe(400);
    expect((await call("GET", "/api/music/abc/state")).status).toBe(400);
  });

  test("voice channels of a server the bot is not in are 404", async () => {
    const { bot } = fakeBot(answering(null));
    started = await startTestServer({ bot });
    const response = await call("GET", `/api/music/${GUILD}/voice-channels`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_guild" });
  });

  test("a search waits longer for the bot; a refusal is 422", async () => {
    const { bot, requests } = fakeBot(
      answering({ status: "rejected", reason: "unsupported_link" }),
    );
    started = await startTestServer({ bot });
    const response = await call(
      "GET",
      `/api/music/${GUILD}/search?q=${encodeURIComponent(" lato ")}`,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "rejected", reason: "unsupported_link" });
    expect(requests).toEqual([
      { name: "music.search", payload: { guildId: GUILD, query: "lato" }, options: SLOW },
    ]);
    expect((await call("GET", `/api/music/${GUILD}/search?q=`)).status).toBe(400);
    expect((await call("GET", `/api/music/${GUILD}/search?q=${"a".repeat(201)}`)).status).toBe(400);
  });

  test("a bot that is down is 503", async () => {
    const { bot } = fakeBot(() => ({ ok: false, reason: "unavailable" }));
    started = await startTestServer({ bot });
    const response = await call("GET", `/api/music/${GUILD}/state`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "bot_unavailable" });
  });
});

describe("music changes", () => {
  test.each([
    [
      "join",
      "POST",
      "join",
      { channelId: VOICE },
      "music.join",
      { guildId: GUILD, channelId: VOICE },
      SLOW,
    ],
    [
      "enqueue",
      "POST",
      "queue",
      { searchId: SEARCH, picks: [0, 3], channelId: VOICE },
      "music.enqueue",
      { guildId: GUILD, searchId: SEARCH, picks: [0, 3], channelId: VOICE },
      SLOW,
    ],
    [
      "remove",
      "POST",
      "queue/remove",
      { index: 2, key: "ab12" },
      "music.queue.remove",
      { guildId: GUILD, index: 2, key: "ab12" },
      undefined,
    ],
    [
      "move",
      "POST",
      "queue/move",
      { from: 2, to: 0, key: "ab12" },
      "music.queue.move",
      { guildId: GUILD, from: 2, to: 0, key: "ab12" },
      undefined,
    ],
    ["shuffle", "POST", "queue/shuffle", {}, "music.queue.shuffle", { guildId: GUILD }, undefined],
    [
      "a control",
      "POST",
      "control",
      { action: "seek", key: "ab12", positionMs: 90_000 },
      "music.control",
      { guildId: GUILD, control: { action: "seek", key: "ab12", positionMs: 90_000 } },
      undefined,
    ],
  ])(
    "%s is audited with its request and sent to the bot",
    async (_label, method, path, body, name, payload, options) => {
      const { bot, requests } = fakeBot(answering({ status: "ok", added: 2, skipped: 0 }));
      const { auditor, audited } = recordingAuditor();
      started = await startTestServer({ bot, auditor });
      const response = await call(method, `/api/music/${GUILD}/${path}`, body);
      expect(response.status).toBe(200);
      expect(audited).toEqual([{ action: name, context: { guildId: GUILD, payload: body } }]);
      expect(requests).toEqual([options ? { name, payload, options } : { name, payload }]);
    },
  );

  test("clearing the queue is a DELETE without a body, audited", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("DELETE", `/api/music/${GUILD}/queue`);
    expect(response.status).toBe(200);
    expect(audited).toEqual([{ action: "music.queue.clear", context: { guildId: GUILD } }]);
    expect(requests).toEqual([{ name: "music.queue.clear", payload: { guildId: GUILD } }]);
  });

  test.each([
    ["an unknown control", "control", { action: "stop" }],
    ["a volume over 150", "control", { action: "volume", percent: 200 }],
    ["a seek without the track key", "control", { action: "seek", positionMs: 5 }],
    ["no picks", "queue", { searchId: SEARCH, picks: [] }],
    ["a guild id in the body", "join", { channelId: VOICE, guildId: GUILD }],
    ["a body for shuffle", "queue/shuffle", { all: true }],
  ])("400 for %s, before any audit or bot call", async (_label, path, body) => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("POST", `/api/music/${GUILD}/${path}`, body);
    expect(response.status).toBe(400);
    expect(audited).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a refusal by the bot is 422 with its reason", async () => {
    const { bot } = fakeBot(answering({ status: "rejected", reason: "track_changed" }));
    started = await startTestServer({ bot });
    const response = await call("POST", `/api/music/${GUILD}/control`, {
      action: "skip",
      key: "ab12",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "rejected", reason: "track_changed" });
  });

  test("nothing runs without an audit row; a bot that is down is 503", async () => {
    const { bot, requests } = fakeBot(() => ({ ok: false, reason: "timeout" }));
    const { auditor } = recordingAuditor(false);
    started = await startTestServer({ bot, auditor });
    const refused = await call("POST", `/api/music/${GUILD}/control`, { action: "pause" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "audit_unavailable" });
    expect(requests).toEqual([]);
    await started.stop();
    started = await startTestServer({ bot });
    const timedOut = await call("POST", `/api/music/${GUILD}/control`, { action: "pause" });
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toEqual({ error: "bot_timeout" });
  });

  test("a change from another origin is refused by the guard", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    started = await startTestServer({ bot });
    const response = await fetch(`${started.url}/api/music/${GUILD}/control`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Host: started.sameOrigin.Host,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "pause" }),
    });
    expect(response.status).toBe(403);
    expect(requests).toEqual([]);
  });
});
