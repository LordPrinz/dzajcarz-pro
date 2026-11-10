import type { BotModule, CommandSummary, CronScheduler, Logger, Scheduler } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import {
  createDzajcoModule,
  type DzajcoResponder,
  type DzajcoSettingsStore,
} from "@dzajcarz/module-dzajco";
import { createFunModule } from "@dzajcarz/module-fun";
import { createGeneralModule } from "@dzajcarz/module-general";
import {
  createMessagesModule,
  type MessageChannels,
  type ScheduledMessageSender,
  type ScheduledMessageStore,
} from "@dzajcarz/module-messages";
import {
  createModerationModule,
  type ModerationGuild,
  type ModerationLog,
} from "@dzajcarz/module-moderation";
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
import { createRiotModule, type RiotStats } from "@dzajcarz/module-riot";
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
import type { TimeZones } from "./time-zones.ts";

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
  /** Five-field cron, read on each server's clock. */
  scheduledSongCron: string;
  /** Each server's zone (`/timezone`), and its settings for the command. */
  timeZones: TimeZones;
  defaultTimeZone: string;
  // dzajco
  dzajcoSettings: DzajcoSettingsStore;
  dzajcoResponder: DzajcoResponder;
  dzajcoStore: KeyValueStore;
  // moderation
  moderationGuild: ModerationGuild;
  moderationLog: ModerationLog;
  moderationDmLimit: Pick<KeyValueStore, "setIfAbsent">;
  // riot
  riotStats: Partial<RiotStats>;
  riotStore: KeyValueStore;
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
      timeZones: services.timeZones.settings,
      defaultTimeZone: services.defaultTimeZone,
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
      expression: services.scheduledSongCron,
      timeZones: services.timeZones,
      now: () => new Date(),
      logger: services.logger.child({ module: "schedule" }),
    }),
    createStatusModule({
      presence: services.presence,
      clock: services.clock,
      logger: services.logger.child({ module: "status" }),
    }),
    createFunModule({ random: Math.random, now: () => new Date(), timeZones: services.timeZones }),
    createDzajcoModule({
      settings: services.dzajcoSettings,
      responder: services.dzajcoResponder,
      kv: services.dzajcoStore,
      channels: services.channels,
      random: Math.random,
      prefixFor: services.prefixFor,
      logger: services.logger.child({ module: "dzajco" }),
    }),
    createModerationModule({
      guild: services.moderationGuild,
      log: services.moderationLog,
      dmLimit: services.moderationDmLimit,
      timeZones: services.timeZones,
      logger: services.logger.child({ module: "moderation" }),
    }),
    createRiotModule({
      stats: services.riotStats,
      store: services.riotStore,
      now: Date.now,
      logger: services.logger.child({ module: "riot" }),
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
      timeZones: services.timeZones,
      logger: services.logger.child({ module: "messages" }),
    }),
  ];
}
