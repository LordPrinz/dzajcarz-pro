import type { BotModule, CommandSummary, Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createGeneralModule } from "@dzajcarz/module-general";
import {
  createPartyModule,
  type PartyChannels,
  type PartyRepository,
} from "@dzajcarz/module-party";
import {
  createSettingsModule,
  type ModuleToggles,
  type PrefixSettings,
} from "@dzajcarz/module-settings";
import {
  createWelcomeModule,
  type GuildLookup,
  type WelcomeConfigStore,
  type WelcomeSender,
} from "@dzajcarz/module-welcome";

/** Everything modules may ask for. Each module factory picks only what it needs. */
export interface ModuleServices {
  commands: () => readonly CommandSummary[];
  gatewayPing: () => number;
  prefixFor: (guildId: string | null) => Promise<string>;
  prefixSettings: PrefixSettings;
  moduleToggles: ModuleToggles;
  defaultPrefix: string;
  welcomeConfigs: WelcomeConfigStore;
  welcomeSender: WelcomeSender;
  guildLookup: GuildLookup;
  partyAreas: PartyRepository;
  partyChannels: PartyChannels;
  partyLock: Pick<KeyValueStore, "setIfAbsent" | "del">;
  logger: Logger;
}

/** The one list of enabled modules: adding a feature means adding a line here. */
export function createModules(services: ModuleServices): BotModule[] {
  return [
    createGeneralModule(services),
    createSettingsModule({
      prefixes: services.prefixSettings,
      defaultPrefix: services.defaultPrefix,
      modules: services.moduleToggles,
    }),
    createWelcomeModule({
      store: services.welcomeConfigs,
      sender: services.welcomeSender,
      guilds: services.guildLookup,
      logger: services.logger.child({ module: "welcome" }),
    }),
    createPartyModule({
      repository: services.partyAreas,
      channels: services.partyChannels,
      lock: services.partyLock,
      logger: services.logger.child({ module: "party" }),
    }),
  ];
}
