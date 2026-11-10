import type { ModuleToggleRepository } from "@dzajcarz/db";
import type { ModuleToggles } from "@dzajcarz/module-settings";
import type { ModuleGate } from "./module-gate.ts";

/** Writes to Postgres, then drops the cached set so the change applies on the next message. */
export function createModuleToggles(
  repository: ModuleToggleRepository,
  gate: Pick<ModuleGate, "forget">,
  moduleNames: () => readonly string[],
): ModuleToggles {
  return {
    moduleNames,
    list: (guildId) => repository.listDisabled(guildId),
    async disable(guildId, module, channelId) {
      await repository.disable(guildId, module, channelId);
      await gate.forget(guildId);
    },
    async enable(guildId, module, channelId) {
      const changed = await repository.enable(guildId, module, channelId);
      await gate.forget(guildId);
      return changed;
    },
  };
}
