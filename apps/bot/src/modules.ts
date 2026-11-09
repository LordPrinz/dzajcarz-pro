import type { BotModule, CommandSummary, CronScheduler, Logger, Scheduler } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createGeneralModule } from "@dzajcarz/module-general";
import {
  createMessagesModule,
  type MessageChannels,
  type ScheduledMessageSender,
  type ScheduledMessageStore,
} from "@dzajcarz/module-messages";
import {
  createMusicModule,
  type DirectMessages,
  type MusicPlayer,
  type PanelMessages,
  type VoiceChannels,
} from "@dzajcarz/module-music";
import {
  createPartyModule,
  type PartyChannels,
  type PartyChat,
  type PartyInvites,
  type PartyPermissions,
  type PartyRepository,
} from "@dzajcarz/module-party";
import {
  createScheduleModule,
  type ScheduledSong,
  type ScheduledSongPlayer,
  type ScheduleSettings,
  type ScheduleVoice,
} from "@dzajcarz/module-schedule";
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
  partyInvites: PartyInvites;
  scheduler: Scheduler;
  partyLock: Pick<KeyValueStore, "get" | "setIfAbsent" | "delIfEquals" | "increment">;
  presence: Presence;
  clock: Clock;
  musicPlayer: MusicPlayer;
  voiceChannels: VoiceChannels;
  musicPanels: PanelMessages;
  directMessages: DirectMessages;
  componentState: Pick<KeyValueStore, "get" | "set">;
  cron: CronScheduler;
  scheduleSettings: ScheduleSettings;
  scheduleVoice: ScheduleVoice;
  scheduledSongPlayer: ScheduledSongPlayer;
  scheduledSongs: readonly [ScheduledSong, ...ScheduledSong[]];
  scheduledSongCron: { expression: string; timeZone: string };
  // messages
  scheduledMessages: ScheduledMessageStore;
  scheduledMessageSender: ScheduledMessageSender;
  guildModuleEnabled: (guildId: string, module: string) => Promise<boolean>;
  messageLock: KeyValueStore;
  messageChannels: MessageChannels;
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
      invites: services.partyInvites,
      scheduler: services.scheduler,
      lock: services.partyLock,
      logger: services.logger.child({ module: "party" }),
    }),
    createMusicModule({
      player: services.musicPlayer,
      voice: services.voiceChannels,
      panels: services.musicPanels,
      directMessages: services.directMessages,
      scheduler: services.scheduler,
      stateStorage: services.componentState,
      logger: services.logger.child({ module: "music" }),
    }),
    createScheduleModule({
      settings: services.scheduleSettings,
      voice: services.scheduleVoice,
      player: services.scheduledSongPlayer,
      cron: services.cron,
      moduleEnabled: services.moduleEnabled,
      songs: services.scheduledSongs,
      expression: services.scheduledSongCron.expression,
      timeZone: services.scheduledSongCron.timeZone,
      logger: services.logger.child({ module: "schedule" }),
    }),
    createStatusModule({
      presence: services.presence,
      clock: services.clock,
      logger: services.logger.child({ module: "status" }),
    }),
    createMessagesModule({
      store: services.scheduledMessages,
      sender: services.scheduledMessageSender,
      channels: services.messageChannels,
      cron: services.cron,
      lock: services.messageLock,
      botInGuild: services.botInGuild,
      moduleEnabled: services.moduleEnabled,
      guildModuleEnabled: services.guildModuleEnabled,
      now: () => new Date(),
      timeZone: "Europe/Warsaw",
      logger: services.logger.child({ module: "messages" }),
    }),
  ];
}
