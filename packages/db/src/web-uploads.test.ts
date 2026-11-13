import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "./testing.ts";
import { WEB_ROLE } from "./web-audit.ts";
import {
  createUploadStaging,
  createUploadStore,
  isStagingFull,
  MAX_STAGED_BYTES,
  type StagedUpload,
  UPLOAD_LEASE_MINUTES,
  UPLOAD_TTL_MINUTES,
} from "./web-uploads.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE web_upload`;
});

const db = (): SQL => {
  if (!sql) throw new Error("no test database");
  return sql;
};

/** Runs `query` as the panel's role in a transaction of its own, so a refused statement aborts only it. */
const asWeb = <T>(query: (tx: SQL) => Promise<T>): Promise<T> =>
  db().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${WEB_ROLE}`);
    return query(tx);
  }) as Promise<T>;

const bytes = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!sql)("web uploads", () => {
  const send = (files: StagedUpload[]) => Promise.resolve(files);
  const always = () => true;

  test("the bot claims what the panel staged, in the order asked", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await asWeb(async (tx) => {
      await createUploadStaging(tx).stage({ id: first, name: "a.txt", data: bytes("hej") });
      await createUploadStaging(tx).stage({
        id: second,
        name: "b.png",
        data: new Uint8Array([0, 255, 0, 7]),
      });
    });
    const store = createUploadStore(db());
    expect(
      (await store.sizes([second, crypto.randomUUID(), first])).sort((a, b) => a.size - b.size),
    ).toEqual([
      { id: first, size: 3 },
      { id: second, size: 4 },
    ]);
    const claimed = await store.claim([second, first], "n1", send, always);
    if (claimed.status !== "ok") throw new Error(claimed.status);
    expect(claimed.value.map(({ id, name, size }) => ({ id, name, size }))).toEqual([
      { id: second, name: "b.png", size: 4 },
      { id: first, name: "a.txt", size: 3 },
    ]);
    expect(new TextDecoder().decode(claimed.value[1]?.data)).toBe("hej");
  });

  test("an unknown id is missing, and nothing is sent", async () => {
    let called = false;
    const result = await createUploadStore(db()).claim(
      [crypto.randomUUID()],
      "n1",
      async () => {
        called = true;
      },
      always,
    );
    expect(result).toEqual({ status: "missing" });
    expect(called).toBe(false);
  });

  test("a sent file stays for a retry with the same nonce, and is refused to another", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    const store = createUploadStore(db());
    expect((await store.claim([id], "n1", send, always)).status).toBe("ok");
    expect((await store.claim([id], "n1", send, always)).status).toBe("ok");
    expect(await store.claim([id], "n2", send, always)).toEqual({ status: "taken" });
  });

  test("a failed send leaves the file free for any nonce", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    const store = createUploadStore(db());
    expect((await store.claim([id], "n1", send, () => false)).status).toBe("ok");
    expect((await store.claim([id], "n2", send, always)).status).toBe("ok");
  });

  test("a send in flight holds the files without a transaction: another is busy, not blocked", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    const store = createUploadStore(db());
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.claim(
      [id],
      "n1",
      async (files) => {
        await gate;
        return files;
      },
      always,
    );
    await Bun.sleep(30);
    expect(await store.claim([id], "n1", send, always)).toEqual({ status: "busy" });
    expect(await store.claim([id], "n2", send, always)).toEqual({ status: "busy" });
    release();
    expect((await first).status).toBe("ok");
    expect(await store.claim([id], "n2", send, always)).toEqual({ status: "taken" });
  });

  test("a send that throws gives the lease back", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    const store = createUploadStore(db());
    await expect(
      store.claim([id], "n1", () => Promise.reject(new Error("discord down")), always),
    ).rejects.toThrow("discord down");
    expect((await store.claim([id], "n2", send, always)).status).toBe("ok");
  });

  test("a stale lease is taken over, and a partly leased set leases nothing", async () => {
    const held = crypto.randomUUID();
    const free = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id: held, name: "a.txt", data: bytes("x") });
    await createUploadStaging(db()).stage({ id: free, name: "b.txt", data: bytes("y") });
    await db()`UPDATE web_upload SET claimed_at = now() WHERE id = ${held}`;
    const store = createUploadStore(db());
    expect(await store.claim([held, free], "n1", send, always)).toEqual({ status: "busy" });
    const [row] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM web_upload WHERE id = ${free} AND claimed_at IS NULL
    `;
    expect(row?.n).toBe(1);
    await db()`
      UPDATE web_upload SET claimed_at = now() - make_interval(mins => ${UPLOAD_LEASE_MINUTES + 1})
      WHERE id = ${held}
    `;
    expect((await store.claim([held, free], "n1", send, always)).status).toBe("ok");
  });

  test("an uppercase id finds its file", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    const result = await createUploadStore(db()).claim([id.toUpperCase()], "n1", send, always);
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.value.map((file) => file.id)).toEqual([id]);
  });

  test("an expired upload is not claimed and is purged", async () => {
    const old = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id: old, name: "old.txt", data: bytes("x") });
    await createUploadStaging(db()).stage({ id: fresh, name: "new.txt", data: bytes("y") });
    await db()`
      UPDATE web_upload SET created_at = now() - make_interval(mins => ${UPLOAD_TTL_MINUTES + 1})
      WHERE id = ${old}
    `;
    const store = createUploadStore(db());
    expect(await store.sizes([old, fresh])).toEqual([{ id: fresh, size: 1 }]);
    expect(await store.claim([old], "n1", send, always)).toEqual({ status: "missing" });
    expect(await store.purgeExpired()).toBe(1);
    const [left] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM web_upload`;
    expect(left?.n).toBe(1);
  });

  test("the quota is 500 MiB", async () => {
    const [row] = await db()<{ quota: string }[]>`SELECT web_upload_quota_bytes()::text AS quota`;
    expect(Number(row?.quota)).toBe(MAX_STAGED_BYTES);
  });

  test("files past the quota are refused, also for the panel; expired ones do not count", async () => {
    const rollback = new Error("rollback");
    /**
     * Lowers the quota to 3 MiB and fills it, inside a transaction that is rolled back: the test stores
     * 3 MiB instead of 500, and the real limit is back afterwards.
     */
    const withSmallQuotaFull = (check: (tx: SQL) => Promise<void>) =>
      db()
        .begin(async (tx) => {
          await tx.unsafe(
            "CREATE OR REPLACE FUNCTION web_upload_quota_bytes() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 3145728::bigint $$",
          );
          const mib = new Uint8Array(1024 * 1024);
          for (let i = 0; i < 3; i++) {
            await createUploadStaging(tx).stage({ id: crypto.randomUUID(), name: "f", data: mib });
          }
          await check(tx);
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
    const stageAsWeb = async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL ROLE ${WEB_ROLE}`);
      await createUploadStaging(tx).stage({ id: crypto.randomUUID(), name: "f", data: bytes("x") });
    };

    let refused: unknown;
    await withSmallQuotaFull(async (tx) => {
      refused = await stageAsWeb(tx).catch((error: unknown) => error);
    });
    expect(isStagingFull(refused)).toBe(true);

    let staged = false;
    await withSmallQuotaFull(async (tx) => {
      await tx`UPDATE web_upload SET created_at = now() - interval '2 hours'`;
      await stageAsWeb(tx);
      staged = true;
    });
    expect(staged).toBe(true);

    const [row] = await db()<{ quota: string }[]>`SELECT web_upload_quota_bytes()::text AS quota`;
    expect(Number(row?.quota)).toBe(MAX_STAGED_BYTES);
    const [left] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM web_upload`;
    expect(left?.n).toBe(0);
  });

  test("an empty file, a long name and a size that lies are refused", async () => {
    const staging = createUploadStaging(db());
    await expect(
      staging.stage({ id: crypto.randomUUID(), name: "a", data: new Uint8Array() }),
    ).rejects.toThrow();
    await expect(
      staging.stage({ id: crypto.randomUUID(), name: "x".repeat(201), data: bytes("x") }),
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO web_upload (id, name, size, data)
           VALUES (${crypto.randomUUID()}, 'a', 5, ${bytes("x")})`,
    ).rejects.toThrow();
  });
});

describe.skipIf(!sql)("the web panel's rights on web_upload", () => {
  test("can stage a file", async () => {
    await asWeb((tx) =>
      createUploadStaging(tx).stage({ id: crypto.randomUUID(), name: "a.txt", data: bytes("x") }),
    );
    const [count] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM web_upload`;
    expect(count?.n).toBe(1);
  });

  test("cannot read, change or delete staged files, or backdate one", async () => {
    const id = crypto.randomUUID();
    await createUploadStaging(db()).stage({ id, name: "a.txt", data: bytes("x") });
    await expect(asWeb((tx) => tx`SELECT data FROM web_upload`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asWeb((tx) => createUploadStore(tx).sizes([id]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asWeb((tx) => tx`UPDATE web_upload SET name = 'b'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asWeb((tx) => tx`DELETE FROM web_upload`)).rejects.toThrow(/permission denied/);
    await expect(
      asWeb(
        (tx) => tx`INSERT INTO web_upload (id, name, size, data, sent_nonce)
                   VALUES (${crypto.randomUUID()}, 'a', 1, ${bytes("x")}, 'n1')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asWeb(
        (tx) => tx`INSERT INTO web_upload (id, name, size, data, created_at)
                   VALUES (${crypto.randomUUID()}, 'a', 1, ${bytes("x")}, now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
