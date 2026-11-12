import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createArchiveReader } from "./archive-reader.ts";
import { type ArchivedMessageInput, createMessageArchiveRepository } from "./message-archive.ts";
import { createTestDatabase } from "./testing.ts";
import { WEB_ROLE } from "./web-audit.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE archived_message, archived_message_version`;
});

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000009";
const CHANNEL = "200000000000000002";
const OTHER_CHANNEL = "200000000000000008";
const DM = "200000000000000003";
const OLA = "300000000000000003";
const JAN = "300000000000000004";
const BOT = "300000000000000005";

const id = (n: number) => String(500000000000000000n + BigInt(n));
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));

function message(n: number, overrides: Partial<ArchivedMessageInput> = {}): ArchivedMessageInput {
  return {
    id: id(n),
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: OLA, username: "ola", displayName: "Ola", avatarUrl: null, bot: false },
    content: `wiadomość ${n}`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: at(n),
    editedAt: null,
    ...overrides,
  };
}

describe.skipIf(!sql)("archive reader", () => {
  const db = () => sql as SQL;
  const reader = () => createArchiveReader(db());
  const store = (messages: ArchivedMessageInput[]) =>
    createMessageArchiveRepository(db()).insertMissing(messages);
  const ids = (page: { messages: { id: string }[] } | null) => page?.messages.map((m) => m.id);

  describe("page", () => {
    beforeEach(async () => {
      await store([
        ...Array.from({ length: 10 }, (_, i) => message(i + 1)),
        message(50, { channelId: OTHER_CHANNEL }),
      ]);
    });

    test("the latest page is oldest first and knows there is more", async () => {
      const page = await reader().page(CHANNEL, { kind: "latest" }, 4);
      expect(ids(page)).toEqual([id(7), id(8), id(9), id(10)]);
      expect(page).toMatchObject({ hasOlder: true, hasNewer: false });
    });

    test("pages back in time until the start", async () => {
      const page = await reader().page(CHANNEL, { kind: "before", messageId: id(3) }, 4);
      expect(ids(page)).toEqual([id(1), id(2)]);
      expect(page).toMatchObject({ hasOlder: false, hasNewer: true });
    });

    test("pages forward", async () => {
      const page = await reader().page(CHANNEL, { kind: "after", messageId: id(6) }, 3);
      expect(ids(page)).toEqual([id(7), id(8), id(9)]);
      expect(page).toMatchObject({ hasOlder: true, hasNewer: true });
    });

    test("a page around a message holds it in the middle", async () => {
      const page = await reader().page(CHANNEL, { kind: "around", messageId: id(5) }, 4);
      expect(ids(page)).toEqual([id(4), id(5), id(6), id(7)]);
      expect(page).toMatchObject({ hasOlder: true, hasNewer: true });
    });

    test("ties on the timestamp are broken by id", async () => {
      await store([message(60, { createdAt: at(10) }), message(61, { createdAt: at(10) })]);
      const page = await reader().page(CHANNEL, { kind: "before", messageId: id(61) }, 2);
      expect(ids(page)).toEqual([id(10), id(60)]);
    });

    test("a cursor from another channel is null, an empty channel an empty page", async () => {
      expect(await reader().page(CHANNEL, { kind: "before", messageId: id(50) }, 4)).toBeNull();
      expect(await reader().page("299999999999999999", { kind: "latest" }, 4)).toEqual({
        messages: [],
        hasOlder: false,
        hasNewer: false,
      });
    });

    test("keeps deleted messages, with when they went", async () => {
      await createMessageArchiveRepository(db()).markDeleted([id(10)], at(30));
      const page = await reader().page(CHANNEL, { kind: "latest" }, 1);
      expect(page?.messages[0]).toMatchObject({ id: id(10), deletedAt: at(30) });
    });
  });

  test("versions come oldest first", async () => {
    const archive = createMessageArchiveRepository(db());
    await store([message(1, { content: "pierwsza" })]);
    await archive.recordEdit(message(1, { content: "druga", editedAt: at(2) }));
    await archive.recordEdit(message(1, { content: "trzecia", editedAt: at(3) }));
    const versions = await reader().versions(id(1));
    expect(versions.map((v) => [v.content, v.editedAt])).toEqual([
      ["pierwsza", null],
      ["druga", at(2)],
    ]);
    expect(await reader().versions(id(2))).toEqual([]);
  });

  describe("search", () => {
    beforeEach(async () => {
      await store([
        message(1, { content: "Pizza na obiad" }),
        message(2, { content: "kto chce pizza?", author: { ...message(0).author, id: JAN } }),
        message(3, { content: "pizza w innym kanale", channelId: OTHER_CHANNEL }),
        message(4, { content: "pizza na innym serwerze", guildId: OTHER_GUILD }),
        message(5, { content: "pizza w DM", guildId: null, channelId: DM }),
        message(6, { content: "nic tu nie ma" }),
      ]);
    });

    const search = (overrides: Partial<Parameters<ReturnType<typeof reader>["search"]>[0]>) =>
      reader().search({ text: "pizza", limit: 10, ...overrides });

    test("finds words regardless of case, newest first", async () => {
      expect(ids(await search({}))).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    });

    test("filters by server, DMs, channel, author and dates", async () => {
      expect(ids(await search({ scope: { guildId: GUILD } }))).toEqual([id(3), id(2), id(1)]);
      expect(ids(await search({ scope: "dm" }))).toEqual([id(5)]);
      expect(ids(await search({ channelId: OTHER_CHANNEL }))).toEqual([id(3)]);
      expect(ids(await search({ authorId: JAN }))).toEqual([id(2)]);
      expect(ids(await search({ from: at(2), to: at(4) }))).toEqual([id(3), id(2)]);
    });

    test("understands web-search syntax", async () => {
      expect(ids(await search({ text: '"pizza na" -serwerze' }))).toEqual([id(1)]);
      expect(ids(await search({ text: "obiad OR DM" }))).toEqual([id(5), id(1)]);
    });

    test("pages with a cursor", async () => {
      const first = await search({ limit: 2 });
      expect(ids(first)).toEqual([id(5), id(4)]);
      expect(first.hasMore).toBe(true);
      const second = await search({ limit: 2, before: id(4) });
      expect(ids(second)).toEqual([id(3), id(2)]);
      const last = await search({ limit: 2, before: id(2) });
      expect(ids(last)).toEqual([id(1)]);
      expect(last.hasMore).toBe(false);
    });

    test("text that holds no word finds nothing, and SQL in it is only text", async () => {
      expect(ids(await search({ text: "!!!" }))).toEqual([]);
      expect(ids(await search({ text: "'); DROP TABLE archived_message; --" }))).toEqual([]);
      expect(ids(await search({}))).toHaveLength(5);
    });
  });

  test("author names come from each author's latest message", async () => {
    await store([
      message(1, { author: { ...message(0).author, displayName: "Stara Ola" } }),
      message(2),
      message(3, {
        author: { id: JAN, username: "jan", displayName: null, avatarUrl: null, bot: false },
      }),
    ]);
    expect(await reader().authorNames([OLA, JAN, BOT])).toEqual(
      new Map([
        [OLA, "Ola"],
        [JAN, "jan"],
      ]),
    );
    expect(await reader().authorNames([])).toEqual(new Map());
  });

  test("DM conversations: the person on the other side, most recent first", async () => {
    const bot = { id: BOT, username: "dzajcarz", displayName: null, avatarUrl: null, bot: true };
    const other = "200000000000000004";
    await store([
      message(1, { guildId: null, channelId: DM }),
      message(2, { guildId: null, channelId: DM, author: bot }),
      message(3, { guildId: null, channelId: other, author: bot }),
      message(4),
    ]);
    const dms = await reader().dmChannels(10);
    expect(dms).toEqual([
      { channelId: other, recipient: null, lastMessageId: id(3), lastMessageAt: at(3) },
      {
        channelId: DM,
        recipient: { id: OLA, username: "ola", displayName: "Ola", avatarUrl: null },
        lastMessageId: id(2),
        lastMessageAt: at(2),
      },
    ]);
    expect(await reader().dmChannels(1)).toHaveLength(1);
  });

  test("where a channel and a message live", async () => {
    await store([message(1), message(2, { guildId: null, channelId: DM })]);
    expect(await reader().channelGuild(CHANNEL)).toBe(GUILD);
    expect(await reader().channelGuild(DM)).toBeNull();
    expect(await reader().channelGuild("299999999999999999")).toBeUndefined();
    expect(await reader().messagePlace(id(2))).toEqual({ guildId: null, channelId: DM });
    expect(await reader().messagePlace(id(9))).toBeNull();
  });

  test("a page older than a cursor uses the channel index with a generic plan", async () => {
    await store(Array.from({ length: 20 }, (_, i) => message(i + 1)));
    const plan = await db().begin(async (tx) => {
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx`SET LOCAL enable_seqscan = off`;
      await tx.unsafe(`
        PREPARE older_page(text, timestamptz, text, int) AS
        SELECT message_id FROM archived_message m
        WHERE m.channel_id = $1 AND (m.created_at, m.message_id) < ($2, $3)
        ORDER BY m.created_at DESC, m.message_id DESC LIMIT $4`);
      const rows = await tx.unsafe(
        `EXPLAIN EXECUTE older_page('${CHANNEL}', '${at(10).toISOString()}', '${id(10)}', 5)`,
      );
      await tx.unsafe("DEALLOCATE older_page");
      return (rows as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("archived_message_channel_idx");
    expect(plan).toMatch(/Index Cond: .*channel_id = \$1.*created_at/);
  });

  test("the web panel's role has a statement timeout", async () => {
    const [row] = await db()<{ setconfig: string[] }[]>`
      SELECT setconfig FROM pg_db_role_setting
      WHERE setrole = ${WEB_ROLE}::regrole AND setdatabase = 0
    `;
    expect(row?.setconfig).toContain("statement_timeout=5s");
  });

  test("the web panel's role can run every read", async () => {
    await store([message(1), message(2, { guildId: null, channelId: DM })]);
    await db().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${WEB_ROLE}`);
      const asWeb = createArchiveReader(tx);
      expect(ids(await asWeb.page(CHANNEL, { kind: "latest" }, 5))).toEqual([id(1)]);
      expect(await asWeb.versions(id(1))).toEqual([]);
      expect(ids(await asWeb.search({ text: "wiadomość", limit: 5 }))).toHaveLength(2);
      expect((await asWeb.authorNames([OLA])).get(OLA)).toBe("Ola");
      expect(await asWeb.dmChannels(5)).toHaveLength(1);
      expect(await asWeb.channelGuild(CHANNEL)).toBe(GUILD);
      expect(await asWeb.messagePlace(id(1))).toEqual({ guildId: GUILD, channelId: CHANNEL });
    });
  });
});
