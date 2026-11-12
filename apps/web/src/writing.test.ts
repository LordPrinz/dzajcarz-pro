import { afterEach, describe, expect, test } from "bun:test";
import type { NewUpload } from "@dzajcarz/db";
import { type BotClient, type BotResult, MAX_UPLOAD_BYTES } from "@dzajcarz/web-protocol";
import type { AuditContext, Auditor } from "./audit.ts";
import { startTestServer, type TestServer } from "./testing.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const MESSAGE = "500000000000000001";
const OLA = "300000000000000002";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

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

async function call(method: string, path: string, body?: unknown) {
  if (!started) throw new Error("no server");
  return fetch(`${started.url}${path}`, {
    method,
    headers: { ...started.sameOrigin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const sendBody = { content: "hej @everyone", allowMentions: false, nonce: "n1" };

describe("POST /api/channels/:channelId/messages", () => {
  test("is audited with the full request and sent to the bot", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok", messageId: MESSAGE }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const body = { ...sendBody, replyTo: MESSAGE, attachmentIds: [crypto.randomUUID()] };
    const response = await call("POST", `/api/channels/${CHANNEL}/messages`, body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "ok", messageId: MESSAGE });
    expect(audited).toEqual([
      { action: "message.send", context: { channelId: CHANNEL, payload: body } },
    ]);
    expect(requests).toEqual([["message.send", { channelId: CHANNEL, ...body }]]);
  });

  test.each([
    ["no mention switch", { content: "hej", nonce: "n1" }],
    ["text over 2000 characters", { ...sendBody, content: "x".repeat(2001) }],
    ["no text and no files", { ...sendBody, content: " " }],
    [
      "eleven files",
      { ...sendBody, attachmentIds: Array.from({ length: 11 }, () => crypto.randomUUID()) },
    ],
    ["no nonce", { content: "hej", allowMentions: false }],
    ["a channel in the body", { ...sendBody, channelId: CHANNEL }],
  ])("400 for %s, before any audit or bot call", async (_label, body) => {
    const { bot, requests } = fakeBot(answering({ status: "ok", messageId: MESSAGE }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("POST", `/api/channels/${CHANNEL}/messages`, body);
    expect(response.status).toBe(400);
    expect(audited).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a refusal by the bot is 422 with its reason", async () => {
    const { bot } = fakeBot(answering({ status: "rejected", reason: "no_send" }));
    started = await startTestServer({ bot });
    const response = await call("POST", `/api/channels/${CHANNEL}/messages`, sendBody);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "rejected", reason: "no_send" });
  });

  test("a bot that is down is 503, and nothing runs without an audit row", async () => {
    const down = fakeBot(() => ({ ok: false, reason: "unavailable" }));
    started = await startTestServer({ bot: down.bot });
    expect(
      await (await call("POST", `/api/channels/${CHANNEL}/messages`, sendBody)).json(),
    ).toEqual({ error: "bot_unavailable" });
    await started.stop();
    const { bot, requests } = fakeBot(answering({ status: "ok", messageId: MESSAGE }));
    started = await startTestServer({ bot, auditor: recordingAuditor(false).auditor });
    const response = await call("POST", `/api/channels/${CHANNEL}/messages`, sendBody);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "audit_unavailable" });
    expect(requests).toEqual([]);
  });
});

describe("editing, deleting and reactions", () => {
  test("an edit is audited with the message and sent to the bot", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const body = { content: "nowe", allowMentions: true };
    const response = await call("PATCH", `/api/channels/${CHANNEL}/messages/${MESSAGE}`, body);
    expect(response.status).toBe(200);
    expect(audited).toEqual([
      {
        action: "message.edit",
        context: { channelId: CHANNEL, payload: { messageId: MESSAGE, ...body } },
      },
    ]);
    expect(requests).toEqual([
      ["message.edit", { channelId: CHANNEL, messageId: MESSAGE, ...body }],
    ]);
  });

  test("editing someone else's message is 422 not_own", async () => {
    const { bot } = fakeBot(answering({ status: "rejected", reason: "not_own" }));
    started = await startTestServer({ bot });
    const response = await call("PATCH", `/api/channels/${CHANNEL}/messages/${MESSAGE}`, {
      content: "x",
      allowMentions: false,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "rejected", reason: "not_own" });
  });

  test("a delete is audited; without Manage Messages the reason comes back", async () => {
    const { bot, requests } = fakeBot(answering({ status: "rejected", reason: "no_manage" }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("DELETE", `/api/channels/${CHANNEL}/messages/${MESSAGE}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "rejected", reason: "no_manage" });
    expect(audited).toEqual([
      {
        action: "message.delete",
        context: { channelId: CHANNEL, payload: { messageId: MESSAGE } },
      },
    ]);
    expect(requests).toEqual([["message.delete", { channelId: CHANNEL, messageId: MESSAGE }]]);
  });

  test("reactions are added and removed by emoji", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const path = `/api/channels/${CHANNEL}/messages/${MESSAGE}/reactions`;
    expect((await call("PUT", path, { emoji: "👍" })).status).toBe(200);
    expect((await call("DELETE", path, { emoji: "dzajco:123456789012345678" })).status).toBe(200);
    expect(audited.map((entry) => entry.action)).toEqual(["reaction.add", "reaction.remove"]);
    expect(requests).toEqual([
      ["reaction.add", { channelId: CHANNEL, messageId: MESSAGE, emoji: "👍" }],
      [
        "reaction.remove",
        { channelId: CHANNEL, messageId: MESSAGE, emoji: "dzajco:123456789012345678" },
      ],
    ]);
  });

  test.each([
    ["text", { emoji: "hej" }],
    ["a path", { emoji: "../../x" }],
    ["two emoji", { emoji: "👍👍" }],
    ["no emoji", {}],
  ])("a reaction with %s is 400", async (_label, body) => {
    const { bot, requests } = fakeBot(answering({ status: "ok" }));
    started = await startTestServer({ bot });
    const response = await call(
      "PUT",
      `/api/channels/${CHANNEL}/messages/${MESSAGE}/reactions`,
      body,
    );
    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
  });

  test("a bad message id is 400", async () => {
    started = await startTestServer();
    expect((await call("DELETE", `/api/channels/${CHANNEL}/messages/abc`)).status).toBe(400);
  });
});

describe("POST /api/uploads", () => {
  function stagingSpy(fail = false) {
    const staged: NewUpload[] = [];
    return {
      staged,
      uploads: {
        stage: async (upload: NewUpload) => {
          if (fail) throw new Error("db down");
          staged.push(upload);
        },
      },
    };
  }

  const upload = (name: string, body: string | Uint8Array, type = "application/octet-stream") => {
    if (!started) throw new Error("no server");
    return fetch(`${started.url}/api/uploads?${new URLSearchParams({ name })}`, {
      method: "POST",
      headers: { ...started.sameOrigin, "Content-Type": type },
      body,
    });
  };

  test("stages the raw file and audits its name and size, not its bytes", async () => {
    const { staged, uploads } = stagingSpy();
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ uploads, auditor });
    const response = await upload("zdjęcie.png", new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(staged).toEqual([{ id, name: "zdjęcie.png", data: new Uint8Array([1, 2, 3]) }]);
    expect(audited).toEqual([
      { action: "upload.stage", context: { payload: { id, name: "zdjęcie.png", size: 3 } } },
    ]);
  });

  test("a JSON or form body is 415", async () => {
    const { staged, uploads } = stagingSpy();
    started = await startTestServer({ uploads });
    expect((await upload("a.txt", "{}", "application/json")).status).toBe(415);
    expect((await upload("a.txt", "a=1", "application/x-www-form-urlencoded")).status).toBe(415);
    expect(staged).toEqual([]);
  });

  test.each([
    ["an empty name", ""],
    ["a slash", "../a.txt"],
    ["a control character", "a\nb.txt"],
    ["a right-to-left override", "zdjecie\u202Egnp.exe"],
    ["a zero-width space", "a\u200B.txt"],
    ["a byte order mark inside", "a\uFEFF.txt"],
    ["an isolate", "a\u2066b.txt"],
    ["a name over 200 characters", "x".repeat(201)],
  ])("%s is 400", async (_label, name) => {
    const { staged, uploads } = stagingSpy();
    started = await startTestServer({ uploads });
    expect((await upload(name, "x")).status).toBe(400);
    expect(staged).toEqual([]);
  });

  test("an empty file is 400 and one over the ceiling is 413", async () => {
    const { staged, uploads } = stagingSpy();
    started = await startTestServer({ uploads });
    expect((await upload("a.txt", new Uint8Array())).status).toBe(400);
    expect((await upload("a.txt", new Uint8Array(MAX_UPLOAD_BYTES + 1))).status).toBe(413);
    expect(staged).toEqual([]);
  });

  test("a file at the ceiling passes", async () => {
    const { staged, uploads } = stagingSpy();
    started = await startTestServer({ uploads });
    expect((await upload("a.bin", new Uint8Array(MAX_UPLOAD_BYTES))).status).toBe(201);
    expect(staged[0]?.data.byteLength).toBe(MAX_UPLOAD_BYTES);
  });

  test("a database that is down is 503", async () => {
    started = await startTestServer({ uploads: stagingSpy(true).uploads });
    const response = await upload("a.txt", "x");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "database_unavailable" });
  });

  test("a full staging table is 503 uploads_full", async () => {
    const full = Object.assign(new Error("web_upload is full"), { errno: "23514" });
    started = await startTestServer({
      uploads: {
        stage: async () => {
          throw full;
        },
      },
    });
    const response = await upload("a.txt", "x");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "uploads_full" });
  });

  test("at most two uploads at once: a third is 429 until one ends", async () => {
    const release: (() => void)[] = [];
    const staged: string[] = [];
    started = await startTestServer({
      uploads: {
        stage: (file: NewUpload) =>
          new Promise<void>((resolve) => {
            staged.push(file.name);
            release.push(resolve);
          }),
      },
    });
    const first = upload("1.txt", "x");
    const second = upload("2.txt", "x");
    while (staged.length < 2) await Bun.sleep(1);
    const third = await upload("3.txt", "x");
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "uploads_busy" });
    for (const done of release) done();
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    const fourth = upload("4.txt", "x");
    while (staged.length < 3) await Bun.sleep(1);
    release[2]?.();
    expect((await fourth).status).toBe(201);
  });

  test("a body streamed past the ceiling is cut off with 413", async () => {
    const { staged, uploads } = stagingSpy();
    started = await startTestServer({ uploads });
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    // No Content-Length: the body arrives in chunks.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_BYTES) controller.close();
        else {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const response = await upload("a.bin", body as unknown as Uint8Array);
    expect(response.status).toBe(413);
    expect(staged).toEqual([]);
  });
});

describe("JSON bodies", () => {
  test("a chunked JSON body is cut off at 64 KB, whatever the server's own ceiling", async () => {
    const { bot, requests } = fakeBot(answering({ status: "ok", messageId: MESSAGE }));
    started = await startTestServer({ bot });
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 1024 * 1024) controller.close();
        else {
          sent += 16 * 1024;
          controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        }
      },
    });
    const response = await fetch(`${started.url}/api/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { ...started.sameOrigin, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
    expect(requests).toEqual([]);
    // The server stopped reading long before the whole megabyte.
    expect(sent).toBeLessThan(1024 * 1024);
  });
});

describe("channel info, members and DMs", () => {
  test("channel info comes from the bot, an unknown channel is 404", async () => {
    const info = {
      status: "ok",
      guildId: GUILD,
      botUserId: OLA,
      uploadLimit: 1024,
      can: { send: true, attach: true, history: true, manage: false },
    };
    const { bot } = fakeBot((_name, payload) =>
      (payload as { channelId: string }).channelId === CHANNEL
        ? { ok: true, data: info }
        : { ok: true, data: { status: "unknown_channel" } },
    );
    started = await startTestServer({ bot });
    expect(await (await fetch(`${started.url}/api/channels/${CHANNEL}/info`)).json()).toEqual(info);
    expect((await fetch(`${started.url}/api/channels/${MESSAGE}/info`)).status).toBe(404);
  });

  test("member search is not audited and goes to the bot", async () => {
    const { bot, requests } = fakeBot(answering({ members: [] }));
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    expect((await fetch(`${started.url}/api/members?q=ol&guild=${GUILD}`)).status).toBe(200);
    expect((await fetch(`${started.url}/api/members?q=ol`)).status).toBe(200);
    expect((await fetch(`${started.url}/api/members?q=`)).status).toBe(400);
    expect((await fetch(`${started.url}/api/members?q=o`)).status).toBe(400);
    expect(requests).toEqual([
      ["members.search", { guildId: GUILD, query: "ol" }],
      ["members.search", { guildId: null, query: "ol" }],
    ]);
    expect(audited).toEqual([]);
  });

  test("opening a DM is audited", async () => {
    const { bot } = fakeBot(
      answering({
        status: "ok",
        channelId: CHANNEL,
        recipient: { id: OLA, username: "ola", displayName: null, avatarUrl: null },
      }),
    );
    const { auditor, audited } = recordingAuditor();
    started = await startTestServer({ bot, auditor });
    const response = await call("POST", "/api/dms/open", { userId: OLA });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ channelId: CHANNEL });
    expect(audited).toEqual([{ action: "dm.open", context: { payload: { userId: OLA } } }]);
  });

  test("the reading routes on the same paths still answer", async () => {
    const { bot } = fakeBot(answering({ channels: [], truncated: false }));
    started = await startTestServer({ bot });
    expect((await fetch(`${started.url}/api/dms`)).status).toBe(200);
  });
});
