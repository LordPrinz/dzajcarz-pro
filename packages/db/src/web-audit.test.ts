import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { MIGRATIONS } from "./migrations.ts";
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

  test("not even the owner can change a finished row or anything but the outcome of a pending one", async () => {
    if (!sql) return;
    const repository = createWebAuditRepository(sql);
    const { id: finished } = await repository.start(entry());
    await repository.finish(finished, "failed", "nope");
    await expect(sql`UPDATE web_audit SET error = NULL WHERE id = ${finished}`).rejects.toThrow(
      /finished and cannot change/,
    );
    const { id: pending } = await repository.start(entry());
    await expect(
      sql`UPDATE web_audit SET payload = '{"forged": true}'::jsonb WHERE id = ${pending}`,
    ).rejects.toThrow(/only the outcome and error/);
    await expect(sql`UPDATE web_audit SET actor = 'someone' WHERE id = ${pending}`).rejects.toThrow(
      /only the outcome and error/,
    );
    await expect(
      sql`INSERT INTO web_audit (action, outcome) VALUES ('message.send', 'timeout')`,
    ).rejects.toThrow(/starts as pending/);
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

  test("cannot rewrite a finished row", async () => {
    const id = await asWeb(async (tx) => {
      const repository = createWebAuditRepository(tx);
      const started = await repository.start(entry());
      await repository.finish(started.id, "ok");
      return started.id;
    });
    await expect(
      asWeb((tx) => tx`UPDATE web_audit SET outcome = 'failed', error = 'later' WHERE id = ${id}`),
    ).rejects.toThrow(/finished and cannot change/);
    await expect(
      asWeb((tx) => tx`UPDATE web_audit SET outcome = 'pending' WHERE id = ${id}`),
    ).rejects.toThrow(/finished and cannot change/);
    expect(await asWeb((tx) => rowOf(tx, id))).toMatchObject({ outcome: "ok", error: null });
  });

  test("cannot update a pending row without giving it an outcome", async () => {
    const id = await asWeb(async (tx) => (await createWebAuditRepository(tx).start(entry())).id);
    await expect(
      asWeb((tx) => tx`UPDATE web_audit SET error = 'again' WHERE id = ${id}`),
    ).rejects.toThrow(/must give web_audit row/);
    expect(await asWeb((tx) => rowOf(tx, id))).toMatchObject({ outcome: "pending", error: null });
  });

  test("cannot insert a row that is not pending", async () => {
    await expect(
      asWeb(
        (tx) =>
          tx`INSERT INTO web_audit (actor, action, outcome) VALUES ('x', 'message.send', 'ok')`,
      ),
    ).rejects.toThrow(/starts as pending/);
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

describe.skipIf(!sql)("migration 0014 on a managed Postgres", () => {
  test("without CREATEROLE and without the role it skips the role and its grants instead of failing", async () => {
    if (!sql) return;
    const migration = MIGRATIONS.find(({ name }) => name === "0014_web_audit.sql");
    if (!migration) throw new Error("0014 is missing");
    // A role name nobody has, so the shared role is left alone; everything is rolled back at the end.
    const name = `test_web_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const rolledBack = new Error("rolled back");
    const outcome = sql.begin(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${name}_owner NOLOGIN NOCREATEROLE`);
      await tx.unsafe(`CREATE SCHEMA ${name} AUTHORIZATION ${name}_owner`);
      await tx.unsafe(`SET LOCAL search_path = ${name}`);
      await tx.unsafe(`SET LOCAL ROLE ${name}_owner`);
      await tx.unsafe(migration.content.replaceAll(WEB_ROLE, name));
      const [role] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${name}`;
      expect(role?.n).toBe(0);
      expect(await tx`SELECT to_regclass('web_audit') IS NOT NULL AS present`).toEqual([
        { present: true },
      ]);
      throw rolledBack;
    });
    await expect(outcome).rejects.toBe(rolledBack);
  });
});
