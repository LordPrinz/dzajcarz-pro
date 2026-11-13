import type { SQL } from "bun";

/** How long a staged file waits before it is deleted, sent or not. */
export const UPLOAD_TTL_MINUTES = 60;
/** How long a send may hold its files; a longer lease is stale (migration 0019). */
export const UPLOAD_LEASE_MINUTES = 10;
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
  | { status: "taken" }
  /** Another send holds the files right now. */
  | { status: "busy" };

/** The bot's side: it reads what the panel staged and deletes it once expired. */
export interface UploadStore {
  /** Id and size of the unexpired uploads among `ids`, without their bytes. */
  sizes(ids: readonly string[]): Promise<{ id: string; size: number }[]>;
  /**
   * Leases the uploads `ids` (in the order of `ids`) for one send with `nonce` and hands them to `send`, which
   * runs outside any transaction; when `sent` says the message went out, they are marked as sent with that
   * nonce, otherwise (or when `send` throws) the lease is given back. Files another send holds are "busy",
   * and files sent with another nonce are "taken"; the same nonce gets them again, so Discord can deduplicate.
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

    async claim<T>(
      ids: readonly string[],
      nonce: string,
      send: (files: StagedUpload[]) => Promise<T>,
      sent: (value: T) => boolean,
    ): Promise<ClaimResult<T>> {
      // Postgres prints a uuid in lowercase, whatever case the caller sent.
      const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
      const rows = await sql<StagedUpload[]>`
        UPDATE web_upload SET claimed_at = now()
        WHERE id = ANY(${wanted}::uuid[])
          AND created_at > now() - make_interval(mins => ${UPLOAD_TTL_MINUTES})
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => ${UPLOAD_LEASE_MINUTES}))
          AND (sent_nonce IS NULL OR sent_nonce = ${nonce})
        RETURNING id::text AS id, name, size, data
      `;
      const leased = rows.map((row) => row.id);
      const release = () =>
        sql`UPDATE web_upload SET claimed_at = NULL WHERE id = ANY(${leased}::uuid[])`;
      if (rows.length !== wanted.length) {
        if (leased.length > 0) await release();
        const present = await sql<{ sent_nonce: string | null }[]>`
          SELECT sent_nonce FROM web_upload
          WHERE id = ANY(${wanted}::uuid[])
            AND created_at > now() - make_interval(mins => ${UPLOAD_TTL_MINUTES})
        `;
        if (present.length !== wanted.length) return { status: "missing" };
        return present.some((row) => row.sent_nonce !== null && row.sent_nonce !== nonce)
          ? { status: "taken" }
          : { status: "busy" };
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const files = ids.flatMap((id) => {
        const row = byId.get(id.toLowerCase());
        return row ? [row] : [];
      });
      let value: T;
      try {
        value = await send(files);
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
      if (sent(value)) {
        await sql`
          UPDATE web_upload SET sent_nonce = ${nonce}, claimed_at = NULL
          WHERE id = ANY(${leased}::uuid[])
        `;
      } else {
        await release();
      }
      return { status: "ok", value };
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
