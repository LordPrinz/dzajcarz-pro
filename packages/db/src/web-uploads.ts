import type { SQL } from "bun";

/** How long a staged file waits before it is deleted, sent or not. */
export const UPLOAD_TTL_MINUTES = 60;
/** At most this many bytes of unexpired files at once (the trigger in migration 0018). */
export const MAX_STAGED_BYTES = 500 * 1024 * 1024;

/** Postgres's code for the full-table refusal of the trigger. */
const CHECK_VIOLATION = "23514";

/** Whether `stage` failed because the table already holds `MAX_STAGED_BYTES`. */
export const isStagingFull = (error: unknown): boolean =>
  (error as { errno?: unknown } | null)?.errno === CHECK_VIOLATION &&
  String((error as { message?: unknown }).message).includes("web_upload is full");

export interface NewUpload {
  /** Chosen by the panel: its role may not read the table, so it cannot get the id back from the insert. */
  id: string;
  name: string;
  data: Uint8Array;
}

export interface StagedUpload {
  id: string;
  name: string;
  size: number;
  data: Buffer;
}

/** The panel's side: it may only add files (migration 0018). */
export interface UploadStaging {
  stage(upload: NewUpload): Promise<void>;
}

export type ClaimResult<T> =
  | { status: "ok"; value: T }
  /** One of the ids is unknown or expired. */
  | { status: "missing" }
  /** One of the files was sent by a message with another nonce. */
  | { status: "taken" };

/** The bot's side: it reads what the panel staged and deletes it once expired. */
export interface UploadStore {
  /** Id and size of the unexpired uploads among `ids`, without their bytes. */
  sizes(ids: readonly string[]): Promise<{ id: string; size: number }[]>;
  /**
   * Locks the uploads `ids` (in the order of `ids`) for one send with `nonce` and hands them to `send`; when
   * `sent` says the message went out, they are marked as sent with that nonce. A concurrent send of the same
   * files waits for the lock, then gets them only with the same nonce, so Discord can deduplicate it.
   */
  claim<T>(
    ids: readonly string[],
    nonce: string,
    send: (files: StagedUpload[]) => Promise<T>,
    sent: (value: T) => boolean,
  ): Promise<ClaimResult<T>>;
  /** Deletes uploads older than the time limit; returns how many. */
  purgeExpired(): Promise<number>;
}

export function createUploadStaging(sql: SQL): UploadStaging {
  return {
    async stage({ id, name, data }) {
      await sql`
        INSERT INTO web_upload (id, name, size, data)
        VALUES (${id}, ${name}, ${data.byteLength}, ${data})
      `;
    },
  };
}

export function createUploadStore(sql: SQL): UploadStore {
  return {
    async sizes(ids) {
      if (ids.length === 0) return [];
      return sql<{ id: string; size: number }[]>`
        SELECT id::text AS id, size FROM web_upload
        WHERE id = ANY(${[...ids]}::uuid[])
          AND created_at > now() - make_interval(mins => ${UPLOAD_TTL_MINUTES})
      `;
    },

    claim<T>(
      ids: readonly string[],
      nonce: string,
      send: (files: StagedUpload[]) => Promise<T>,
      sent: (value: T) => boolean,
    ): Promise<ClaimResult<T>> {
      return sql.begin(async (tx) => {
        const rows = await tx<(StagedUpload & { sent_nonce: string | null })[]>`
          SELECT id::text AS id, name, size, data, sent_nonce FROM web_upload
          WHERE id = ANY(${[...ids]}::uuid[])
            AND created_at > now() - make_interval(mins => ${UPLOAD_TTL_MINUTES})
          ORDER BY id
          FOR UPDATE
        `;
        if (rows.length !== new Set(ids).size) return { status: "missing" as const };
        if (rows.some((row) => row.sent_nonce !== null && row.sent_nonce !== nonce)) {
          return { status: "taken" as const };
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        const files = ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [{ id: row.id, name: row.name, size: row.size, data: row.data }] : [];
        });
        const value = await send(files);
        if (sent(value)) {
          await tx`UPDATE web_upload SET sent_nonce = ${nonce} WHERE id = ANY(${[...ids]}::uuid[])`;
        }
        return { status: "ok" as const, value } satisfies ClaimResult<T>;
      }) as Promise<ClaimResult<T>>;
    },

    async purgeExpired() {
      const rows = await sql`
        DELETE FROM web_upload
        WHERE created_at <= now() - make_interval(mins => ${UPLOAD_TTL_MINUTES})
        RETURNING id
      `;
      return rows.length;
    },
  };
}
