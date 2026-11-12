import type { ArchiveSettingsRepository } from "@dzajcarz/db";
import type { ArchiveBackfill } from "./archive-backfill.ts";
import type { ArchivePolicy } from "./archive-policy.ts";
import type { ArchiveControl } from "./web-bridge.ts";

/** Writes to Postgres, then refreshes the cached settings so the change applies to the next message. */
export function createArchiveControl({
  settings,
  policy,
  backfill,
}: {
  settings: Pick<ArchiveSettingsRepository, "setGuild" | "setDm">;
  policy: Pick<ArchivePolicy, "forgetGuild" | "forgetDm">;
  backfill: ArchiveBackfill;
}): ArchiveControl {
  return {
    async setGuild(request) {
      const saved = await settings.setGuild(request);
      await policy.forgetGuild(saved.guildId);
      return saved;
    },
    async setDm({ enabled }) {
      const saved = await settings.setDm(enabled);
      await policy.forgetDm();
      return { enabled: saved };
    },
    backfill,
  };
}
