import type { SQL } from "bun";
import type { WebAuditOutcome, WebAuditRow } from "./types.ts";

/** The database role the web panel logs in as (migration 0014). */
export const WEB_ROLE = "dzajcarz_web";

export interface NewWebAuditEntry {
  /** `X-authentik-username`, or null when the proxy did not send it. */
  actor: string | null;
  /** Dotted lower-case name, e.g. `message.send`. */
  action: string;
  guildId?: string | null;
  channelId?: string | null;
  /** Validated by the caller's zod schema before it gets here. */
  payload?: unknown;
}

export type FinalWebAuditOutcome = Exclude<WebAuditOutcome, "pending">;

export interface WebAuditRepository {
  /** Writes the row as `pending`, before the action runs. */
  start(entry: NewWebAuditEntry): Promise<{ id: number }>;
  /** Sets the outcome of a `pending` row; a row that already has one is left as it is. */
  finish(id: number, outcome: FinalWebAuditOutcome, error?: string | null): Promise<void>;
}

/** Whether the migrations that create `web_audit` ran; the panel never runs them itself. */
export async function webAuditTableExists(sql: SQL): Promise<boolean> {
  const [row] = await sql<
    { present: boolean }[]
  >`SELECT to_regclass('web_audit') IS NOT NULL AS present`;
  return row?.present === true;
}

export function createWebAuditRepository(sql: SQL): WebAuditRepository {
  return {
    async start(entry) {
      const [row] = await sql<Pick<WebAuditRow, "id">[]>`
        INSERT INTO web_audit (actor, action, guild_id, channel_id, payload, outcome)
        VALUES (${entry.actor}, ${entry.action}, ${entry.guildId ?? null}, ${entry.channelId ?? null},
          ${JSON.stringify(entry.payload ?? {})}::text::jsonb, 'pending')
        RETURNING id
      `;
      if (!row) throw new Error("INSERT INTO web_audit returned no row");
      return { id: Number(row.id) };
    },

    async finish(id, outcome, error = null) {
      await sql`
        UPDATE web_audit SET outcome = ${outcome}, error = ${error}
        WHERE id = ${id} AND outcome = 'pending'
      `;
    },
  };
}
