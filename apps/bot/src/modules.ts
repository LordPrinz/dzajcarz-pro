import type { BotModule, CommandSummary } from "@dzajcarz/core";
import { createGeneralModule } from "@dzajcarz/module-general";
import { createSettingsModule, type PrefixSettings } from "@dzajcarz/module-settings";

/** Everything modules may ask for. Each module factory picks only what it needs. */
export interface ModuleServices {
  commands: () => readonly CommandSummary[];
  gatewayPing: () => number;
  prefixFor: (guildId: string | null) => Promise<string>;
  prefixSettings: PrefixSettings;
  defaultPrefix: string;
}

/** The one list of enabled modules: adding a feature means adding a line here. */
export function createModules(services: ModuleServices): BotModule[] {
  return [
    createGeneralModule(services),
    createSettingsModule({
      prefixes: services.prefixSettings,
      defaultPrefix: services.defaultPrefix,
    }),
  ];
}
