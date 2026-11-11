import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "./testing.ts";
import type { WebAuditRow } from "./types.ts";
import {
  createWebAuditRepository,
  type NewWebAuditEntry,
  WEB_ROLE,
  webAuditTableExists,
} from "./web-audit.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE web_audit`;
});

function entry(overrides: Partial<NewWebAuditEntry> = {}): NewWebAuditEntry {
  return { actor: "owner", action: "message.send", ...overrides };
}

const rowOf = async (db: SQL, id: number) =>
  (await db<WebAuditRow[]>`SELECT * FROM web_audit WHERE id = ${id}`)[0];

describe.skipIf(!sql)("web audit repository", () => {
  test("start writes a pending row with every field and returns the id", async () => {
    if (!sql) return;
    const { id } = await createWebAuditRepository(sql).start(
      entry({
        guildId: "100000000000000001",
        channelId: "200000000000000002",
        payload: { content: "hej", allowMentions: false },
      }),
    );
    const row = await rowOf(sql, id);
    expect(row).toMatchObject({
      actor: "owner",
      action: "message.send",
      guild_id: "100000000000000001",
      channel_id: "200000000000000002",
      payload: { content: "hej", allowMentions: false },
      outcome: "pending",
      error: null,
    });
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  test("the actor can be null and the optional fields default", async () => {
    if (!sql) return;
    const { id } = await createWebAuditRepository(sql).start(entry({ actor: null }));
    expect(await rowOf(sql, id)).toMatchObject({
      actor: null,
      guild_id: null,
      channel_id: null,
      payload: {},
      error: null,
    });
  });

  test.each(["ok", "failed", "unavailable", "timeout", "rejected"] as const)(
    "finish sets the outcome %s",
    async (outcome) => {
      if (!sql) return;
      const repository = createWebAuditRepository(sql);
      const { id } = await repository.start(entry());
      await repository.finish(id, outcome, outcome === "failed" ? "Missing Permissions" : null);
      expect(await rowOf(sql, id)).toMatchObject({
        outcome,
        error: outcome === "failed" ? "Missing Permissions" : null,
      });
    },
  );

  test("finish leaves a row that already has an outcome as it is", async () => {
    if (!sql) return;
    const repository = createWebAuditRepository(sql);
    const { id } = await repository.start(entry());
    await repository.finish(id, "ok");
    await repository.finish(id, "failed", "late");
    expect(await rowOf(sql, id)).toMatchObject({ outcome: "ok", error: null });
  });

  test("rejects an outcome the table does not know", async () => {
    if (!sql) return;
    const repository = createWebAuditRepository(sql);
    const { id } = await repository.start(entry());
    await expect(repository.finish(id, "maybe" as never)).rejects.toThrow();
  });

  test.each(["Send", "send", "message", "message.", "message.Send", "message send"])(
    "rejects the action name %p",
    async (action) => {
      if (!sql) return;
      await expect(createWebAuditRepository(sql).start(entry({ action }))).rejects.toThrow();
    },
  );

  test("rejects an error longer than 1000 characters", async () => {
    if (!sql) return;
    const repository = createWebAuditRepository(sql);
    const { id } = await repository.start(entry());
    await expect(repository.finish(id, "failed", "e".repeat(1_001))).rejects.toThrow();
  });

  test("rejects an actor longer than 255 characters", async () => {
    if (!sql) return;
    await expect(
      createWebAuditRepository(sql).start(entry({ actor: "a".repeat(256) })),
    ).rejects.toThrow();
  });

  test("webAuditTableExists sees the migrated table", async () => {
    if (!sql) return;
    expect(await webAuditTableExists(sql)).toBe(true);
  });
});

describe.skipIf(!sql)("the web panel's database role", () => {
  /** Runs `query` as the panel's role in a transaction of its own, so a refused statement aborts only it. */
  const asWeb = <T>(query: (tx: SQL) => Promise<T>): Promise<T> => {
    if (!sql) throw new Error("no test database");
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${WEB_ROLE}`);
      return query(tx);
    }) as Promise<T>;
  };

  test("can start and finish an audit row and read it back", async () => {
    const id = await asWeb(async (tx) => {
      const repository = createWebAuditRepository(tx);
      const started = await repository.start(entry());
      await repository.finish(started.id, "ok");
      return started.id;
    });
    expect(await asWeb((tx) => rowOf(tx, id))).toMatchObject({ outcome: "ok" });
  });

  test("cannot rewrite who did what, or delete a row", async () => {
    if (!sql) return;
    const { id } = await createWebAuditRepository(sql).start(entry());
    await expect(
      asWeb((tx) => tx`UPDATE web_audit SET actor = 'someone' WHERE id = ${id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(asWeb((tx) => tx`DELETE FROM web_audit WHERE id = ${id}`)).rejects.toThrow(
      /permission denied/,
    );
  });

  test("cannot read or write the bot's tables", async () => {
    await expect(asWeb((tx) => tx`SELECT * FROM guild_settings`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asWeb((tx) => tx`INSERT INTO guild_settings (guild_id) VALUES ('100000000000000001')`),
    ).rejects.toThrow(/permission denied/);
    await expect(asWeb((tx) => tx`SELECT * FROM schema_migrations`)).rejects.toThrow(
      /permission denied/,
    );
  });

  test("cannot create tables", async () => {
    await expect(asWeb((tx) => tx`CREATE TABLE web_extra (id int)`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
