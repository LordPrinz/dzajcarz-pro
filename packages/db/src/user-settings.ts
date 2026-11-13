import type { SQL } from "bun";
import type { UserSettingsRow } from "./types.ts";

export interface UserSettingsRepository {
  find(userId: string): Promise<UserSettingsRow | null>;
  /** Sets the member's own language (`pl`, `en`, `de`); null drops the choice. */
  setLocale(userId: string, locale: string | null): Promise<UserSettingsRow>;
}

export function createUserSettingsRepository(sql: SQL): UserSettingsRepository {
  return {
    async find(userId) {
      const [row] = await sql<UserSettingsRow[]>`
        SELECT * FROM user_settings WHERE user_id = ${userId}
      `;
      return row ?? null;
    },

    async setLocale(userId, locale) {
      const [row] = await sql<UserSettingsRow[]>`
        INSERT INTO user_settings (user_id, locale) VALUES (${userId}, ${locale})
        ON CONFLICT (user_id) DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()
        RETURNING *
      `;
      if (!row) throw new Error("Upsert into user_settings returned no row");
      return row;
    },
  };
}
