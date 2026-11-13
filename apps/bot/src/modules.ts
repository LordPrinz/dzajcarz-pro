import type { BotModule, CommandSummary, CronScheduler, Logger, Scheduler } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import {
  type BirthdayMembers,
  type BirthdaySender,
  type BirthdayStore,
  createBirthdayModule,
} from "@dzajcarz/module-birthday";
import {
  createDzajcoModule,
  type DzajcoChannels,
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
  type PartyGuild,
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
import type { Locales } from "./locales.ts";
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
  partyGuild: PartyGuild;
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
  /**
   * Each server's and member's language (`/language`). A module that sends text outside a command
   * (events, cron jobs, DMs it starts) takes it as a `LocaleResolver`.
   */
  locales: Locales;
  // dzajco
  dzajcoSettings: DzajcoSettingsStore;
  dzajcoResponder: DzajcoResponder;
  dzajcoStore: KeyValueStore;
  dzajcoChannels: DzajcoChannels;
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
  messageFailures: KeyValueStore;
  clientReady: () => boolean;
  messageChannels: MessageChannels;
  // birthday
  birthdays: BirthdayStore;
  birthdaySender: BirthdaySender;
  birthdayMembers: BirthdayMembers;
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
      languages: services.locales.settings,
    }),
    createWelcomeModule({
      store: services.welcomeConfigs,
      sender: services.welcomeSender,
      guilds: services.guildLookup,
      channels: services.channels,
      moduleEnabled: services.moduleEnabled,
      logger: services.logger.child({ module: "welcome" }),
    }),
    createPartyModule({
      repository: services.partyAreas,
      channels: services.partyChannels,
      permissions: services.partyPermissions,
      guild: services.partyGuild,
      chat: services.partyChat,
      invites: services.partyInvites,
      scheduler: services.scheduler,
      lock: services.partyLock,
      locales: services.locales,
      logger: services.logger.child({ module: "party" }),
    }),
    createMusicModule({
      player: services.musicPlayer,
      voice: services.voiceChannels,
      panels: services.musicPanels,
      directMessages: services.directMessages,
      locales: services.locales,
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
      channels: services.dzajcoChannels,
      random: Math.random,
      prefixFor: services.prefixFor,
      logger: services.logger.child({ module: "dzajco" }),
    }),
    createModerationModule({
      guild: services.moderationGuild,
      log: services.moderationLog,
      dmLimit: services.moderationDmLimit,
      timeZones: services.timeZones,
      locales: services.locales,
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
      failures: services.messageFailures,
      clientReady: services.clientReady,
      botInGuild: services.botInGuild,
      moduleEnabled: services.moduleEnabled,
      guildModuleEnabled: services.guildModuleEnabled,
      locales: services.locales,
      now: () => new Date(),
      timeZones: services.timeZones,
      logger: services.logger.child({ module: "messages" }),
    }),
    createBirthdayModule({
      store: services.birthdays,
      sender: services.birthdaySender,
      members: services.birthdayMembers,
      channels: services.channels,
      cron: services.cron,
      timeZones: services.timeZones,
      locales: services.locales,
      moduleEnabled: services.moduleEnabled,
      now: () => new Date(),
      logger: services.logger.child({ module: "birthday" }),
    }),
  ];
}
