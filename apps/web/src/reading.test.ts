import { afterEach, describe, expect, test } from "bun:test";
import type { ArchiveReader, StoredMessage } from "@dzajcarz/db";
import type { BotClient, BotResult, PanelMessage } from "@dzajcarz/web-protocol";
import { createLiveState } from "./live.ts";
import { hasPositiveTerm, MAX_SEARCH_LENGTH, PAGE_SIZE, SEARCH_PAGE_SIZE } from "./reading.ts";
import { emptyArchive, startTestServer, type TestServer } from "./testing.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "200000000000000003";
const DM = "200000000000000004";
const OLA = "300000000000000003";
const JAN = "300000000000000004";
const id = (n: number) => String(500000000000000000n + BigInt(n));

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

const unavailable = (): BotResult<unknown> => ({ ok: false, reason: "unavailable" });

function stored(n: number, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: id(n),
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: OLA, username: "ola", displayName: "Ola", avatarUrl: null, bot: false },
    content: `wiadomość ${n} <@${JAN}>`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 10, n)),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** An archive that records how it was read. */
function fakeArchive(overrides: Partial<ArchiveReader> = {}) {
  const calls: [string, unknown[]][] = [];
  const archive: ArchiveReader = {
    page: async (...args) => {
      calls.push(["page", args]);
      return { messages: [stored(1), stored(2)], hasOlder: true, hasNewer: false };
    },
    versions: emptyArchive.versions,
    search: async (...args) => {
      calls.push(["search", args]);
      return { messages: [stored(2), stored(1)], hasMore: true };
    },
    authorNames: async (ids) => new Map(ids.filter((x) => x === JAN).map((x) => [x, "Jan"])),
    dmChannels: async () => [],
    channelGuild: async (channelId) => (channelId === CHANNEL ? GUILD : undefined),
    messagePlace: async () => ({ guildId: GUILD, channelId: CHANNEL }),
    ...overrides,
  };
  return { archive, calls };
}

const archivedGuild = (excludedChannelIds: string[] = []) => ({
  listGuilds: async () => [],
  dmEnabled: async () => false,
  findGuild: async (guildId: string) =>
    guildId === GUILD ? { guildId, enabled: true, excludedChannelIds } : null,
});

const get = (path: string) => {
  if (!started) throw new Error("no server");
  return fetch(`${started.url}${path}`);
};

describe("GET /api/channels/:channelId/messages", () => {
  test("an archived channel reads from Postgres, with names from the archive", async () => {
    const { bot, requests } = fakeBot(unavailable);
    const { archive, calls } = fakeArchive();
    started = await startTestServer({ bot, archive, archiveSettings: archivedGuild() });
    const response = await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: PanelMessage[] };
    expect(body).toMatchObject({
      source: "archive",
      resolved: { users: { [JAN]: "Jan" }, roles: {}, channels: {} },
      hasOlder: true,
      hasNewer: false,
    });
    expect(body.messages.map((m) => m.id)).toEqual([id(1), id(2)]);
    expect(calls).toEqual([["page", [CHANNEL, { kind: "latest" }, PAGE_SIZE]]]);
    // The bot is offline (no heartbeat), so it is not asked for names.
    expect(requests).toEqual([]);
  });

  test("an online bot names what it knows; the archive fills in the rest", async () => {
    const live = createLiveState();
    live.record({ guilds: 1, startedAt: "2026-11-01T10:00:00.000Z" });
    const { bot, requests } = fakeBot(() => ({
      ok: true,
      data: { users: {}, roles: {}, channels: { [CHANNEL]: "ogólny" } },
    }));
    const { archive } = fakeArchive({
      page: async () => ({
        messages: [stored(1, { content: `<@${JAN}> w <#${CHANNEL}>` })],
        hasOlder: false,
        hasNewer: false,
      }),
    });
    started = await startTestServer({ bot, archive, live, archiveSettings: archivedGuild() });
    const body = (await (await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}`)).json()) as {
      resolved: unknown;
    };
    expect(body.resolved).toEqual({
      users: { [JAN]: "Jan" },
      roles: {},
      channels: { [CHANNEL]: "ogólny" },
    });
    expect(requests).toEqual([
      ["names.resolve", { guildId: GUILD, users: [JAN], roles: [], channels: [CHANNEL] }],
    ]);
  });

  test("pages back, forward and around a message in an archived channel", async () => {
    const { archive, calls } = fakeArchive();
    started = await startTestServer({ archive, archiveSettings: archivedGuild() });
    await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&before=${id(4)}`);
    await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&after=${id(5)}`);
    await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&around=${id(6)}`);
    expect(calls.map(([, args]) => args[1])).toEqual([
      { kind: "before", messageId: id(4) },
      { kind: "after", messageId: id(5) },
      { kind: "around", messageId: id(6) },
    ]);
  });

  test("paging forward or around a message in a channel outside the archive is 409", async () => {
    const { archive, calls } = fakeArchive();
    started = await startTestServer({ archive, archiveSettings: archivedGuild([CHANNEL]) });
    for (const cursor of [`after=${id(5)}`, `around=${id(6)}`]) {
      const response = await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&${cursor}`);
      expect([response.status, await response.json()]).toEqual([409, { error: "not_archived" }]);
    }
    expect(calls).toEqual([]);
  });

  test("the server comes from the stored messages, not from the request", async () => {
    const { bot, requests } = fakeBot(() => ({ ok: true, data: { status: "no_access" } }));
    const { archive, calls } = fakeArchive();
    // The DM switch is on, the server is not archived: claiming "dm" must not open the stored channel.
    started = await startTestServer({
      bot,
      archive,
      archiveSettings: {
        ...archivedGuild(),
        findGuild: async () => null,
        dmEnabled: async () => true,
      },
    });
    const response = await get(`/api/channels/${CHANNEL}/messages?guild=dm&around=${id(1)}`);
    expect(response.status).toBe(409);
    await get(`/api/channels/${CHANNEL}/messages?guild=dm`);
    expect(calls).toEqual([]);
    expect(requests.map(([name]) => name)).toEqual(["channel.messages"]);
  });

  test("a channel outside the archive is read live through the bot", async () => {
    const message = { id: id(1) };
    const { bot, requests } = fakeBot(() => ({
      ok: true,
      data: { status: "ok", messages: [message], resolved: {}, hasMore: true },
    }));
    const { archive, calls } = fakeArchive();
    started = await startTestServer({ bot, archive, archiveSettings: archivedGuild([CHANNEL]) });
    const response = await get(
      `/api/channels/${THREAD}/messages?guild=${GUILD}&parent=${CHANNEL}&before=${id(9)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: "live",
      messages: [message],
      resolved: {},
      hasOlder: true,
      hasNewer: false,
    });
    expect(requests).toEqual([
      ["channel.messages", { channelId: THREAD, limit: PAGE_SIZE, before: id(9) }],
    ]);
    expect(calls).toEqual([]);
  });

  test("DMs are archived only while the DM switch is on", async () => {
    const { bot, requests } = fakeBot(() => ({ ok: true, data: { status: "no_access" } }));
    started = await startTestServer({ bot });
    expect((await get(`/api/channels/${DM}/messages?guild=dm`)).status).toBe(403);
    expect(requests.map(([name]) => name)).toEqual(["channel.messages"]);
    await started.stop();
    const { archive, calls } = fakeArchive();
    started = await startTestServer({
      archive,
      archiveSettings: { ...archivedGuild(), dmEnabled: async () => true },
    });
    expect((await get(`/api/channels/${DM}/messages?guild=dm`)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("maps the bot's answers and failures to HTTP", async () => {
    const answers: BotResult<unknown>[] = [
      { ok: true, data: { status: "unknown_channel" } },
      { ok: false, reason: "unavailable" },
      { ok: false, reason: "timeout" },
    ];
    const { bot } = fakeBot(() => answers.shift() ?? unavailable());
    started = await startTestServer({ bot });
    const path = `/api/channels/${CHANNEL}/messages?guild=${GUILD}`;
    const first = await get(path);
    expect([first.status, await first.json()]).toEqual([404, { error: "unknown_channel" }]);
    expect(await (await get(path)).json()).toEqual({ error: "bot_unavailable" });
    expect(await (await get(path)).json()).toEqual({ error: "bot_timeout" });
  });

  test("a message that is not in the channel is 404, a broken database 503", async () => {
    started = await startTestServer({
      archive: fakeArchive({ page: async () => null }).archive,
      archiveSettings: archivedGuild(),
    });
    const missing = await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&around=${id(1)}`);
    expect([missing.status, await missing.json()]).toEqual([404, { error: "unknown_message" }]);
    await started.stop();
    started = await startTestServer({
      archiveSettings: {
        ...archivedGuild(),
        findGuild: async () => {
          throw new Error("down");
        },
      },
    });
    const down = await get(`/api/channels/${CHANNEL}/messages?guild=${GUILD}`);
    expect([down.status, await down.json()]).toEqual([503, { error: "database_unavailable" }]);
  });

  test.each([
    ["a channel id that is not a snowflake", "/api/channels/abc/messages?guild=dm", "invalid_id"],
    ["no guild", `/api/channels/${CHANNEL}/messages`, "invalid_query"],
    [
      "a guild that is neither an id nor dm",
      `/api/channels/${CHANNEL}/messages?guild=x`,
      "invalid_query",
    ],
    [
      "two cursors",
      `/api/channels/${CHANNEL}/messages?guild=dm&before=${id(1)}&after=${id(2)}`,
      "invalid_query",
    ],
    [
      "an unknown parameter",
      `/api/channels/${CHANNEL}/messages?guild=dm&limit=500`,
      "invalid_query",
    ],
  ])("400 for %s", async (_label, path, error) => {
    const { bot, requests } = fakeBot(unavailable);
    started = await startTestServer({ bot });
    const response = await get(path);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(error);
    expect(requests).toEqual([]);
  });
});

describe("GET /api/messages/:messageId/versions", () => {
  test("lists the earlier versions, with links checked", async () => {
    const replacedAt = new Date("2026-11-01T11:00:00.000Z");
    const { archive } = fakeArchive({
      versions: async () => [
        {
          content: "przed",
          attachments: [{ id: "1", name: "a.png", url: "javascript:x", size: 1 }],
          embeds: [{ title: "t" }],
          editedAt: null,
          replacedAt,
        },
      ],
    });
    started = await startTestServer({ archive, archiveSettings: archivedGuild() });
    const body = await (await get(`/api/messages/${id(1)}/versions`)).json();
    expect(body).toEqual({
      versions: [
        {
          content: "przed",
          attachments: [
            {
              id: "1",
              name: "a.png",
              url: null,
              contentType: null,
              size: 1,
              width: null,
              height: null,
            },
          ],
          embeds: [expect.objectContaining({ title: "t" })],
          editedAt: null,
          replacedAt: replacedAt.toISOString(),
        },
      ],
    });
    expect((await get("/api/messages/x/versions")).status).toBe(400);
  });
});

describe("versions outside the archive", () => {
  test("a message of a channel no longer archived is 409, an unknown one 404", async () => {
    started = await startTestServer({
      archiveSettings: archivedGuild([CHANNEL]),
      archive: fakeArchive().archive,
    });
    const refused = await get(`/api/messages/${id(1)}/versions`);
    expect([refused.status, await refused.json()]).toEqual([409, { error: "not_archived" }]);
    await started.stop();
    started = await startTestServer({
      archive: fakeArchive({ messagePlace: async () => null }).archive,
    });
    expect((await get(`/api/messages/${id(1)}/versions`)).status).toBe(404);
  });
});

describe("GET /api/search", () => {
  test("passes the filters on and returns a cursor for the next page", async () => {
    const { archive, calls } = fakeArchive();
    started = await startTestServer({ archive });
    const from = "2026-11-01T00:00:00.000+01:00";
    const response = await get(
      `/api/search?q=${encodeURIComponent(" pizza ")}&guild=${GUILD}&channel=${CHANNEL}` +
        `&author=${OLA}&from=${encodeURIComponent(from)}&before=${id(9)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: PanelMessage[]; nextBefore: string };
    expect(body.results.map((m) => m.id)).toEqual([id(2), id(1)]);
    expect(body.nextBefore).toBe(id(1));
    expect(calls).toEqual([
      [
        "search",
        [
          {
            text: "pizza",
            scope: { guildId: GUILD },
            channelId: CHANNEL,
            authorId: OLA,
            from: new Date(from),
            to: undefined,
            before: id(9),
            limit: SEARCH_PAGE_SIZE,
          },
        ],
      ],
    ]);
  });

  test("a search across servers resolves each message's roles against its own server", async () => {
    const live = createLiveState();
    live.record({ guilds: 2, startedAt: "2026-11-01T10:00:00.000Z" });
    const OTHER_GUILD = "100000000000000009";
    const ROLE = "400000000000000001";
    const OTHER_ROLE = "400000000000000002";
    const { bot, requests } = fakeBot((_name, payload) => {
      const { guildId } = payload as { guildId: string | null };
      return {
        ok: true,
        data: {
          users: {},
          roles: guildId === GUILD ? { [ROLE]: "Admini" } : { [OTHER_ROLE]: "Goście" },
          channels: {},
        },
      };
    });
    const { archive } = fakeArchive({
      search: async () => ({
        messages: [
          stored(2, { content: `<@&${ROLE}>` }),
          stored(1, { guildId: OTHER_GUILD, content: `<@&${OTHER_ROLE}>` }),
        ],
        hasMore: false,
      }),
    });
    started = await startTestServer({ bot, archive, live });
    const body = (await (await get("/api/search?q=a")).json()) as { resolved: unknown };
    expect(body.resolved).toMatchObject({ roles: { [ROLE]: "Admini", [OTHER_ROLE]: "Goście" } });
    expect(requests.map(([, payload]) => (payload as { guildId: string }).guildId).sort()).toEqual(
      [GUILD, OTHER_GUILD].sort(),
    );
  });

  test("dm searches DMs only; the last page has no cursor", async () => {
    const { archive, calls } = fakeArchive({
      search: async (...args) => {
        calls.push(["search", args]);
        return { messages: [stored(1)], hasMore: false };
      },
    });
    started = await startTestServer({ archive });
    const body = (await (await get("/api/search?q=x&guild=dm")).json()) as { nextBefore: unknown };
    expect(body.nextBefore).toBeNull();
    const [query] = (calls[0]?.[1] ?? []) as { scope: unknown }[];
    expect(query?.scope).toBe("dm");
  });

  test.each([
    ["no text", "/api/search"],
    ["blank text", "/api/search?q=%20%20"],
    ["text that is too long", `/api/search?q=${"a".repeat(MAX_SEARCH_LENGTH + 1)}`],
    ["a date that is not ISO", "/api/search?q=a&from=yesterday"],
    ["an author that is not an id", "/api/search?q=a&author=ola"],
    ["only excluded words", "/api/search?q=-pizza%20-kebab"],
    ["only OR and punctuation", "/api/search?q=or%20!!!%20%22%22"],
  ])("400 for %s", async (_label, path) => {
    started = await startTestServer();
    expect((await get(path)).status).toBe(400);
  });

  test("a query cut off by the statement timeout is 503 query_timeout", async () => {
    started = await startTestServer({
      archive: fakeArchive({
        search: async () => {
          throw Object.assign(new Error("canceling statement due to statement timeout"), {
            errno: "57014",
          });
        },
      }).archive,
    });
    const response = await get("/api/search?q=a");
    expect([response.status, await response.json()]).toEqual([503, { error: "query_timeout" }]);
  });

  test("503 when the database is down", async () => {
    started = await startTestServer({
      archive: fakeArchive({
        search: async () => {
          throw new Error("down");
        },
      }).archive,
    });
    expect((await get("/api/search?q=a")).status).toBe(503);
  });
});

describe("GET /api/dms", () => {
  const recipient = (displayName: string) => ({
    id: OLA,
    username: "ola",
    displayName,
    avatarUrl: "https://cdn.discordapp.com/avatars/3/a.png",
  });

  test("joins the archive's DMs with the bot's, newest first, the bot's names winning", async () => {
    const other = "200000000000000009";
    const { bot } = fakeBot(() => ({
      ok: true,
      data: {
        channels: [
          // Created 2026-11-01T10:00Z: newer than the archived one.
          {
            channelId: DM,
            recipient: recipient("Ola teraz"),
            lastMessageId: "1566391350067200000",
          },
        ],
        truncated: false,
      },
    }));
    const { archive } = fakeArchive({
      dmChannels: async () => [
        {
          channelId: DM,
          recipient: { ...recipient("Ola kiedyś"), avatarUrl: "https://evil.example/a.png" },
          lastMessageId: id(1),
          lastMessageAt: new Date("2026-10-01T10:00:00.000Z"),
        },
        {
          channelId: other,
          recipient: null,
          lastMessageId: id(2),
          lastMessageAt: new Date("2026-10-15T10:00:00.000Z"),
        },
      ],
    });
    started = await startTestServer({ bot, archive });
    const body = await (await get("/api/dms")).json();
    expect(body).toEqual({
      dms: [
        {
          channelId: DM,
          recipient: recipient("Ola teraz"),
          lastActivity: "2026-11-01T10:00:00.000Z",
        },
        { channelId: other, recipient: null, lastActivity: "2026-10-15T10:00:00.000Z" },
      ],
      bot: "ok",
      truncated: false,
    });
  });

  test("lists the archived DMs while the bot is down, and is 503 only when both fail", async () => {
    const { archive } = fakeArchive({
      dmChannels: async () => [
        {
          channelId: DM,
          recipient: { ...recipient("Ola"), avatarUrl: "https://evil.example/a.png" },
          lastMessageId: id(1),
          lastMessageAt: new Date("2026-10-01T10:00:00.000Z"),
        },
      ],
    });
    started = await startTestServer({ bot: fakeBot(unavailable).bot, archive });
    const body = (await (await get("/api/dms")).json()) as {
      bot: string;
      dms: { recipient: { avatarUrl: string | null } }[];
    };
    expect(body.bot).toBe("unavailable");
    expect(body.dms[0]?.recipient.avatarUrl).toBeNull();
    await started.stop();
    started = await startTestServer({
      bot: fakeBot(unavailable).bot,
      archive: fakeArchive({
        dmChannels: async () => {
          throw new Error("down");
        },
      }).archive,
    });
    expect((await get("/api/dms")).status).toBe(503);
  });
});

describe("hasPositiveTerm", () => {
  test("needs a word that is not excluded", () => {
    expect(hasPositiveTerm("pizza -ananas")).toBe(true);
    expect(hasPositiveTerm('"dokładna fraza"')).toBe(true);
    expect(hasPositiveTerm("-pizza")).toBe(false);
    expect(hasPositiveTerm('-"cała fraza" or')).toBe(false);
    expect(hasPositiveTerm("!!! ...")).toBe(false);
  });
});
