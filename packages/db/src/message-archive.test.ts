import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createArchiveSettingsRepository } from "./archive-settings.ts";
import {
  type ArchivedMessageInput,
  createMessageArchiveRepository,
  jsonWithoutNul,
  withoutNul,
} from "./message-archive.ts";
import { createTestDatabase } from "./testing.ts";
import type { ArchivedMessageRow, ArchivedMessageVersionRow } from "./types.ts";
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
  if (sql) {
    await sql`TRUNCATE archived_message, archived_message_version, archive_settings, archive_dm_settings`;
  }
});

describe("U+0000 stripping", () => {
  test("removes it from text", () => {
    expect(withoutNul("a\u0000b\u0000")).toBe("ab");
    expect(withoutNul("plain")).toBe("plain");
  });

  test("removes it from every string value of the JSON, and only there", () => {
    const text = jsonWithoutNul([
      { name: "a\u0000.png", size: 3, nested: { title: ["x\u0000y", null, true] } },
      { path: "back\\u0000slash" },
    ]);
    expect(JSON.parse(text)).toEqual([
      { name: "a.png", size: 3, nested: { title: ["xy", null, true] } },
      { path: "back\\u0000slash" },
    ]);
  });
});

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";

function message(id: string, overrides: Partial<ArchivedMessageInput> = {}): ArchivedMessageInput {
  return {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    author: {
      id: "300000000000000003",
      username: "ola",
      displayName: "Ola",
      avatarUrl: "https://cdn.discordapp.com/avatars/300000000000000003/a.png",
      bot: false,
    },
    content: `wiadomość ${id}`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    editedAt: null,
    ...overrides,
  };
}

const rowOf = async (db: SQL, id: string) =>
  (await db<ArchivedMessageRow[]>`SELECT * FROM archived_message WHERE message_id = ${id}`)[0];
const versionsOf = (db: SQL, id: string) =>
  db<ArchivedMessageVersionRow[]>`
    SELECT * FROM archived_message_version WHERE message_id = ${id} ORDER BY id`;

describe.skipIf(!sql)("message archive repository", () => {
  const db = () => sql as SQL;
  const repo = () => createMessageArchiveRepository(db());

  test("insertMissing stores every field and counts only the new rows", async () => {
    const attachment = {
      id: "400000000000000004",
      name: "kot.png",
      url: "https://cdn.discordapp.com/attachments/1/2/kot.png",
      contentType: "image/png",
      size: 1234,
      width: 10,
      height: 20,
    };
    const first = message("500000000000000001", {
      attachments: [attachment],
      embeds: [{ title: "Link" }],
      replyToId: "500000000000000000",
    });
    expect(await repo().insertMissing([first, message("500000000000000002")])).toBe(2);
    expect(await rowOf(db(), first.id)).toMatchObject({
      guild_id: GUILD,
      channel_id: CHANNEL,
      author_id: "300000000000000003",
      author_username: "ola",
      author_display_name: "Ola",
      author_bot: false,
      content: "wiadomość 500000000000000001",
      attachments: [attachment],
      embeds: [{ title: "Link" }],
      reply_to_id: "500000000000000000",
      created_at: first.createdAt,
      edited_at: null,
      deleted_at: null,
    });
  });

  test("insertMissing twice stores nothing twice and never changes a stored row", async () => {
    const original = message("500000000000000001");
    await repo().insertMissing([original]);
    expect(
      await repo().insertMissing([
        { ...original, content: "inna treść" },
        message("500000000000000002"),
      ]),
    ).toBe(1);
    expect((await rowOf(db(), original.id))?.content).toBe(original.content);
    const [count] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM archived_message`;
    expect(count?.n).toBe(2);
    expect(await repo().insertMissing([])).toBe(0);
  });

  test("insertMissing stores a page of 100 in one go and an id twice in it once", async () => {
    const page = Array.from({ length: 100 }, (_, i) =>
      message(String(500000000000000100n + BigInt(i))),
    );
    expect(await repo().insertMissing([...page, page[0] as ArchivedMessageInput])).toBe(100);
  });

  test("a DM is stored without a guild", async () => {
    await repo().insertMissing([message("500000000000000001", { guildId: null })]);
    expect((await rowOf(db(), "500000000000000001"))?.guild_id).toBeNull();
  });

  test("recordEdit keeps the previous version and stores the new one", async () => {
    const original = message("500000000000000001");
    await repo().insertMissing([original]);
    const editedAt = new Date("2026-11-01T10:05:00.000Z");
    expect(await repo().recordEdit({ ...original, content: "poprawione", editedAt })).toBe(true);
    const againAt = new Date("2026-11-01T10:06:00.000Z");
    expect(
      await repo().recordEdit({ ...original, content: "jeszcze raz", editedAt: againAt }),
    ).toBe(true);

    expect(await rowOf(db(), original.id)).toMatchObject({
      content: "jeszcze raz",
      edited_at: againAt,
    });
    const versions = await versionsOf(db(), original.id);
    expect(versions.map((v) => [v.content, v.edited_at])).toEqual([
      [original.content, null],
      ["poprawione", editedAt],
    ]);
  });

  test("recordEdit of a message it never saw stores it without a version", async () => {
    const editedAt = new Date("2026-11-01T10:05:00.000Z");
    expect(await repo().recordEdit(message("500000000000000001", { editedAt }))).toBe(false);
    expect((await rowOf(db(), "500000000000000001"))?.edited_at).toEqual(editedAt);
    expect(await versionsOf(db(), "500000000000000001")).toHaveLength(0);
  });

  test("an embed arriving later updates the row without a version", async () => {
    const original = message("500000000000000001");
    await repo().insertMissing([original]);
    expect(await repo().recordEdit({ ...original, embeds: [{ title: "Podgląd" }] })).toBe(false);
    expect((await rowOf(db(), original.id))?.embeds).toEqual([{ title: "Podgląd" }]);
    expect(await versionsOf(db(), original.id)).toHaveLength(0);
  });

  test("a changed attachment list is a new version", async () => {
    const original = message("500000000000000001", {
      attachments: [
        {
          id: "400000000000000004",
          name: "a.txt",
          url: "https://cdn.discordapp.com/attachments/1/2/a.txt",
          contentType: null,
          size: 1,
          width: null,
          height: null,
        },
      ],
    });
    await repo().insertMissing([original]);
    expect(await repo().recordEdit({ ...original, attachments: [] })).toBe(true);
    expect((await versionsOf(db(), original.id))[0]?.attachments).toEqual(original.attachments);
  });

  test("markDeleted keeps the row, sets deleted_at once and ignores unknown ids", async () => {
    await repo().insertMissing([message("500000000000000001"), message("500000000000000002")]);
    const at = new Date("2026-11-02T00:00:00.000Z");
    expect(
      await repo().markDeleted(
        ["500000000000000001", "500000000000000002", "599999999999999999"],
        at,
      ),
    ).toBe(2);
    expect(
      await repo().markDeleted(["500000000000000001"], new Date("2026-11-03T00:00:00.000Z")),
    ).toBe(0);
    expect((await rowOf(db(), "500000000000000001"))?.deleted_at).toEqual(at);
    expect(await repo().markDeleted([], at)).toBe(0);
  });

  test("oldestInChannel is where loading older messages continues", async () => {
    expect(await repo().oldestInChannel(CHANNEL)).toBeNull();
    await repo().insertMissing([
      message("500000000000000003", { createdAt: new Date("2026-11-03T00:00:00.000Z") }),
      message("500000000000000001", { createdAt: new Date("2026-11-01T00:00:00.000Z") }),
      message("500000000000000009", {
        channelId: "200000000000000009",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ]);
    expect(await repo().oldestInChannel(CHANNEL)).toBe("500000000000000001");
  });

  test("the content is searchable with the 'simple' configuration", async () => {
    await repo().insertMissing([message("500000000000000001", { content: "Idziemy na pizzę" })]);
    const rows = await db()<{ message_id: string }[]>`
      SELECT message_id FROM archived_message WHERE search @@ plainto_tsquery('simple', 'pizzę')`;
    expect(rows.map((row) => row.message_id)).toEqual(["500000000000000001"]);
  });
});

describe.skipIf(!sql)("archive settings repository", () => {
  const db = () => sql as SQL;
  const repo = () => createArchiveSettingsRepository(db());

  test("a server without a row and DMs start off", async () => {
    expect(await repo().findGuild(GUILD)).toBeNull();
    expect(await repo().dmEnabled()).toBe(false);
    expect(await repo().listGuilds()).toEqual([]);
  });

  test("setGuild stores the switch and a sorted, de-duplicated exclusion list", async () => {
    const saved = await repo().setGuild({
      guildId: GUILD,
      enabled: true,
      excludedChannelIds: ["200000000000000009", CHANNEL, CHANNEL],
    });
    expect(saved).toEqual({
      guildId: GUILD,
      enabled: true,
      excludedChannelIds: [CHANNEL, "200000000000000009"],
    });
    expect(await repo().findGuild(GUILD)).toEqual(saved);
    const off = await repo().setGuild({ guildId: GUILD, enabled: false, excludedChannelIds: [] });
    expect(off).toEqual({ guildId: GUILD, enabled: false, excludedChannelIds: [] });
    expect(await repo().listGuilds()).toEqual([off]);
  });

  test("the DM switch is a single row", async () => {
    expect(await repo().setDm(true)).toBe(true);
    expect(await repo().setDm(true)).toBe(true);
    expect(await repo().dmEnabled()).toBe(true);
    expect(await repo().setDm(false)).toBe(false);
    const [count] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM archive_dm_settings`;
    expect(count?.n).toBe(1);
    await expect(db()`INSERT INTO archive_dm_settings (id) VALUES (false)`).rejects.toThrow();
  });
});

describe.skipIf(!sql)("the web panel's rights on the archive", () => {
  const asWeb = <T>(query: (tx: SQL) => Promise<T>): Promise<T> => {
    if (!sql) throw new Error("no test database");
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${WEB_ROLE}`);
      return query(tx);
    }) as Promise<T>;
  };

  test("reads the archive and its settings", async () => {
    if (!sql) return;
    await createMessageArchiveRepository(sql).insertMissing([message("500000000000000001")]);
    await createArchiveSettingsRepository(sql).setGuild({
      guildId: GUILD,
      enabled: true,
      excludedChannelIds: [],
    });
    expect(await asWeb((tx) => createArchiveSettingsRepository(tx).listGuilds())).toHaveLength(1);
    expect(await asWeb((tx) => createArchiveSettingsRepository(tx).dmEnabled())).toBe(false);
    expect(await asWeb((tx) => tx`SELECT message_id FROM archived_message`)).toHaveLength(1);
    expect(await asWeb((tx) => tx`SELECT * FROM archived_message_version`)).toEqual([]);
  });

  test("cannot change them", async () => {
    await expect(asWeb((tx) => createArchiveSettingsRepository(tx).setDm(true))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asWeb((tx) =>
        createArchiveSettingsRepository(tx).setGuild({
          guildId: GUILD,
          enabled: true,
          excludedChannelIds: [],
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asWeb((tx) => createMessageArchiveRepository(tx).recordEdit(message("500000000000000001"))),
    ).rejects.toThrow(/permission denied/);
    await expect(asWeb((tx) => tx`DELETE FROM archived_message`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
