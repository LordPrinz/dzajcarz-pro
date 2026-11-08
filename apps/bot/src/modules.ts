import type { BotModule, CommandSummary, Logger, Scheduler } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createGeneralModule } from "@dzajcarz/module-general";
import {
  createMusicModule,
  type MusicPlayer,
  type PanelMessages,
  type VoiceChannels,
} from "@dzajcarz/module-music";
import {
  createPartyModule,
  type PartyChannels,
  type PartyChat,
  type PartyPermissions,
  type PartyRepository,
} from "@dzajcarz/module-party";
import {
  createSettingsModule,
  type GuildChannels,
  type ModuleToggles,
  type PrefixSettings,
} from "@dzajcarz/module-settings";
import { type Clock, createStatusModule, type Presence } from "@dzajcarz/module-status";
import {
  createWelcomeModule,
  type GuildLookup,
  type TextChannels,
  type WelcomeConfigStore,
  type WelcomeSender,
} from "@dzajcarz/module-welcome";

/** Everything modules may ask for. Each module factory picks only what it needs. */
export interface ModuleServices {
  commands: () => readonly CommandSummary[];
  gatewayPing: () => number;
  installLinks: { guild: string; user: string };
  botInGuild: (guildId: string) => boolean;
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
  prefixFor: (guildId: string | null) => Promise<string>;
  prefixSettings: PrefixSettings;
  moduleToggles: ModuleToggles;
  channels: GuildChannels & TextChannels;
  defaultPrefix: string;
  welcomeConfigs: WelcomeConfigStore;
  welcomeSender: WelcomeSender;
  guildLookup: GuildLookup;
  partyAreas: PartyRepository;
  partyChannels: PartyChannels;
  partyPermissions: PartyPermissions;
  partyChat: PartyChat;
  scheduler: Scheduler;
  partyLock: Pick<KeyValueStore, "setIfAbsent" | "delIfEquals" | "increment">;
  presence: Presence;
  clock: Clock;
  musicPlayer: MusicPlayer;
  voiceChannels: VoiceChannels;
  musicPanels: PanelMessages;
  componentState: Pick<KeyValueStore, "get" | "set">;
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
      channels: services.channels,
    }),
    createWelcomeModule({
      store: services.welcomeConfigs,
      sender: services.welcomeSender,
      guilds: services.guildLookup,
      channels: services.channels,
      logger: services.logger.child({ module: "welcome" }),
    }),
    createPartyModule({
      repository: services.partyAreas,
      channels: services.partyChannels,
      permissions: services.partyPermissions,
      chat: services.partyChat,
      scheduler: services.scheduler,
      lock: services.partyLock,
      logger: services.logger.child({ module: "party" }),
    }),
    createMusicModule({
      player: services.musicPlayer,
      voice: services.voiceChannels,
      panels: services.musicPanels,
      scheduler: services.scheduler,
      stateStorage: services.componentState,
      logger: services.logger.child({ module: "music" }),
    }),
    createStatusModule({
      presence: services.presence,
      clock: services.clock,
      logger: services.logger.child({ module: "status" }),
    }),
  ];
}
