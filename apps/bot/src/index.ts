// Composition root: creates the real adapters once and hands them to the modules.
import {
  createCronScheduler,
  createJsonLogger,
  createRegistry,
  createScheduler,
} from "@dzajcarz/core";
import {
  createArchiveSettingsRepository,
  createBirthdayRepository,
  createDb,
  createDzajcoRepository,
  createGuildDataRepository,
  createGuildSettingsRepository,
  createMessageArchiveRepository,
  createModerationRepository,
  createModuleToggleRepository,
  createPartyRepository,
  createScheduledMessageRepository,
  createScheduledSongRepository,
  createUploadStore,
  createUserSettingsRepository,
  createWelcomeRepository,
} from "@dzajcarz/db";
import { migrate } from "@dzajcarz/db/migrator";
import { createRedisPubSub, createRedisStore, createTimedStore, keepConnected } from "@dzajcarz/kv";
import { DZAJCO_GIF } from "@dzajcarz/module-dzajco";
import { parseQuery } from "@dzajcarz/module-music";
import { RedisClient } from "bun";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { createArchiveBackfill } from "./archive-backfill.ts";
import { createArchiveControl } from "./archive-control.ts";
import { createArchivePolicy } from "./archive-policy.ts";
import { createArchiveRecorder } from "./archive-recorder.ts";
import { attachHandlers } from "./bot.ts";
import { deployOnStartup } from "./deploy.ts";
import {
  attachArchiveRecorder,
  createChannelHistory,
  createGuildChannelList,
} from "./discord/archive.ts";
import { createBirthdayMembers, createBirthdaySender } from "./discord/birthday.ts";
import { createDzajcoChannels, createDzajcoResponder } from "./discord/dzajco.ts";
import { createCategoryLookup, createGuildChannels } from "./discord/guild-channels.ts";
import { createInstallLinks } from "./discord/install.ts";
import { createMessageChannels, createScheduledMessageSender } from "./discord/messages.ts";
import { createModerationGuild } from "./discord/moderation.ts";
import { createDirectMessages, createPanelMessages, createVoiceChannels } from "./discord/music.ts";
import {
  createPartyChannels,
  createPartyChat,
  createPartyGuild,
  createPartyInvites,
  createPartyPermissions,
} from "./discord/party.ts";
import { createClock, createPresence } from "./discord/presence.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { createScheduleVoice } from "./discord/schedule.ts";
import { createGuildList } from "./discord/web-guilds.ts";
import { createVoiceDirectory } from "./discord/web-music.ts";
import {
  attachMessageEvents,
  createChannelReader,
  createDmList,
  createNameResolver,
} from "./discord/web-reading.ts";
import { createWriting } from "./discord/web-writing.ts";
import { createGuildLookup, createTextChannels, createWelcomeSender } from "./discord/welcome.ts";
import { loadEnv } from "./env.ts";
import { createModuleEnabled } from "./event-scope.ts";
import { createGuildCleanup } from "./guild-cleanup.ts";
import { gatewayReady, startHealthServer } from "./health.ts";
import { runHealthcheck } from "./healthcheck.ts";
import { createLocales } from "./locales.ts";
import { createModuleGate } from "./module-gate.ts";
import { createModuleToggles } from "./module-toggles.ts";
import { createModules } from "./modules.ts";
import { createLavalinkMusicPlayer } from "./music/lavalink.ts";
import { createScheduledSongPlayer } from "./music/scheduled.ts";
import { SCHEDULED_SONGS } from "./music/scheduled-songs.ts";
import { createUnavailableMusicPlayer } from "./music/unavailable.ts";
import { createPrefixResolver } from "./prefix-resolver.ts";
import { createPrefixSettings } from "./prefix-settings.ts";
import { createRiotStats } from "./riot/stats.ts";
import { createTimeZones } from "./time-zones.ts";
import { startWebBridge } from "./web-bridge.ts";
import { createWebMusic, startMusicEvents } from "./web-music.ts";

// `bot healthcheck` is the container HEALTHCHECK: it needs no token or database, so it runs before loadEnv.
if (process.argv[2] === "healthcheck") process.exit(await runHealthcheck(Bun.env));

const env = loadEnv();
const logger = createJsonLogger({ level: env.LOG_LEVEL });

const sql = createDb(env.DATABASE_URL);
// Before anything touches the schema. A failed migration exits non-zero, so the bot never logs in on a
// half-migrated database and the container's restart policy retries it.
try {
  const applied = await migrate(sql);
  logger.info(applied.length ? "Applied migrations" : "Database is up to date", { applied });
} catch (error) {
  logger.error("Migration failed", { error });
  process.exit(1);
}
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis, logger);
const redisStore = createTimedStore(createRedisStore(redis));
// A subscribed connection accepts nothing but (un)subscribe, so the web panel's pub/sub gets its own.
const redisSubscriber = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
const pubsub = createRedisPubSub({ publisher: redis, subscriber: redisSubscriber, log: logger });
keepConnected(redisSubscriber, logger, { onConnect: pubsub.resubscribe });

const guildSettings = createGuildSettingsRepository(sql);
// Replaced by DEFAULT_TIME_ZONE and /timezone; a leftover value would otherwise be dropped without a word.
if (Bun.env.SCHEDULED_SONG_TIMEZONE) {
  logger.warn("SCHEDULED_SONG_TIMEZONE is no longer read; set DEFAULT_TIME_ZONE or use /timezone", {
    value: Bun.env.SCHEDULED_SONG_TIMEZONE,
  });
}
// Scheduled messages convert times in Postgres, whose tzdata can lack a name the runtime accepts.
if (!(await guildSettings.isKnownTimeZone(env.DEFAULT_TIME_ZONE))) {
  logger.error("DEFAULT_TIME_ZONE is unknown to Postgres; pick a current IANA name", {
    zone: env.DEFAULT_TIME_ZONE,
  });
  process.exit(1);
}
const prefixes = createPrefixResolver({
  settings: guildSettings,
  cache: redisStore,
  defaultPrefix: env.BOT_PREFIX,
  logger: logger.child({ component: "prefix" }),
});
const timeZones = createTimeZones({
  settings: guildSettings,
  cache: redisStore,
  defaultTimeZone: env.DEFAULT_TIME_ZONE,
  logger: logger.child({ component: "time-zone" }),
});
const locales = createLocales({
  guildSettings,
  userSettings: createUserSettingsRepository(sql),
  cache: redisStore,
  logger: logger.child({ component: "locale" }),
});

const archiveSettings = createArchiveSettingsRepository(sql);
const messageArchive = createMessageArchiveRepository(sql);
const archivePolicy = createArchivePolicy({
  settings: archiveSettings,
  cache: redisStore,
  logger: logger.child({ component: "archive" }),
});

const moduleToggleRepository = createModuleToggleRepository(sql);
const gate = createModuleGate({
  toggles: moduleToggleRepository,
  cache: redisStore,
  logger: logger.child({ component: "module-gate" }),
  categoryOf: (channelId) => categoryOf(channelId),
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged: enable "Message Content Intent" in the developer portal, or prefix commands go quiet.
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    // Privileged: enable "Server Members Intent" in the developer portal, or guildMemberAdd never
    // fires and welcome messages stay silent.
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  // DM channels are not cached, so without Channel the bot never sees DM messages. Without Message, a
  // deleted message that is not in the cache (the party panel after a restart) never fires messageDelete.
  partials: [Partials.Channel, Partials.Message],
  allowedMentions: NO_MENTIONS,
});
const categoryOf = createCategoryLookup(client);

// Without a configured node the module still loads, so its commands explain that music is unavailable.
const musicPlayer =
  env.LAVALINK_URL && env.LAVALINK_PASSWORD
    ? createLavalinkMusicPlayer({
        client,
        url: env.LAVALINK_URL,
        password: env.LAVALINK_PASSWORD,
        logger: logger.child({ component: "lavalink" }),
      })
    : createUnavailableMusicPlayer();
if (!env.LAVALINK_URL) logger.info("LAVALINK_URL is not set; music is off");

// Without a key the module still loads, so its commands explain that stats for that game are off.
const riotStats = createRiotStats({
  valorantApiKey: env.RIOT_VALORANT_API_KEY,
  lolApiKey: env.RIOT_LOL_API_KEY,
  cache: redisStore,
  logger: logger.child({ component: "riot" }),
});
if (!env.RIOT_VALORANT_API_KEY)
  logger.info("RIOT_VALORANT_API_KEY is not set; Valorant stats are off");
if (!env.RIOT_LOL_API_KEY)
  logger.info("RIOT_LOL_API_KEY is not set; League of Legends stats are off");

const botInGuild = (guildId: string) => client.guilds.cache.has(guildId);

const modules = createModules({
  commands: () => registry.summaries(),
  gatewayPing: () => client.ws.ping,
  installLinks: createInstallLinks(env.DISCORD_CLIENT_ID),
  botInGuild,
  moduleEnabled: createModuleEnabled(gate, client.channels.cache),
  prefixFor: (guildId) => prefixes.resolve(guildId),
  prefixSettings: createPrefixSettings(guildSettings, prefixes),
  moduleToggles: createModuleToggles(moduleToggleRepository, gate, () =>
    modules.map((module) => module.name),
  ),
  channels: { ...createGuildChannels(client), ...createTextChannels(client) },
  defaultPrefix: env.BOT_PREFIX,
  welcomeConfigs: createWelcomeRepository(sql),
  welcomeSender: createWelcomeSender(client),
  guildLookup: createGuildLookup(client, logger.child({ component: "guild-lookup" })),
  partyAreas: createPartyRepository(sql),
  partyChannels: createPartyChannels(client),
  partyPermissions: createPartyPermissions(client),
  partyGuild: createPartyGuild(client),
  partyChat: createPartyChat(client),
  partyInvites: createPartyInvites(client),
  scheduler: createScheduler(),
  partyLock: redisStore,
  presence: createPresence(client),
  clock: createClock(),
  musicPlayer,
  voiceChannels: createVoiceChannels(client),
  musicPanels: createPanelMessages(client),
  directMessages: createDirectMessages(client),
  componentState: redisStore,
  cron: createCronScheduler(),
  scheduleSettings: createScheduledSongRepository(sql),
  scheduleVoice: createScheduleVoice(client),
  scheduledSongPlayer: createScheduledSongPlayer(musicPlayer),
  scheduledSongs: SCHEDULED_SONGS,
  scheduledSongCron: env.SCHEDULED_SONG_CRON,
  timeZones,
  defaultTimeZone: env.DEFAULT_TIME_ZONE,
  locales,
  dzajcoSettings: createDzajcoRepository(sql),
  dzajcoResponder: createDzajcoResponder(client, logger.child({ component: "dzajco" }), DZAJCO_GIF),
  dzajcoStore: redisStore,
  dzajcoChannels: createDzajcoChannels(client),
  moderationGuild: createModerationGuild(client),
  moderationLog: createModerationRepository(sql),
  moderationDmLimit: redisStore,
  riotStats,
  riotStore: redisStore,
  scheduledMessages: createScheduledMessageRepository(sql, {
    defaultTimeZone: env.DEFAULT_TIME_ZONE,
  }),
  scheduledMessageSender: createScheduledMessageSender(client),
  guildModuleEnabled: (guildId, module) => gate.isEnabled(guildId, null, module),
  messageFailures: redisStore,
  clientReady: () => client.isReady(),
  messageChannels: createMessageChannels(client),
  birthdays: createBirthdayRepository(sql),
  birthdaySender: createBirthdaySender(client),
  birthdayMembers: createBirthdayMembers(client),
  logger,
});
const registry = createRegistry(modules);
attachHandlers(client, {
  registry,
  prefixes,
  gate,
  botInGuild,
  cooldowns: redisStore,
  locales,
  logger,
});

// The panel's message archive (#145): its own listeners, so a failing write never reaches the commands.
attachArchiveRecorder(
  client,
  createArchiveRecorder({
    policy: archivePolicy,
    archive: messageArchive,
    logger: logger.child({ component: "archive" }),
  }),
  logger.child({ component: "archive" }),
);

client.on(
  Events.GuildDelete,
  createGuildCleanup(
    createGuildDataRepository(sql),
    [prefixes.forget, timeZones.forget, locales.forget, gate.forget, archivePolicy.forgetGuild],
    logger.child({ component: "guild-cleanup" }),
  ),
);

const startedAt = new Date().toISOString();
const resolveNames = createNameResolver(client);
// Files the panel staged for a message (#147): deleted once sent, or after an hour by this sweep.
const uploads = createUploadStore(sql);
const UPLOAD_SWEEP_MS = 15 * 60_000;
const sweepUploads = () =>
  void uploads
    .purgeExpired()
    .catch((error: unknown) => logger.warn("Could not delete expired uploads", { error }));
sweepUploads();
const uploadSweep = setInterval(sweepUploads, UPLOAD_SWEEP_MS);
uploadSweep.unref();
// The bridge only answers once the gateway is ready; a failed subscribe is retried when Redis reconnects.
const webBridge = await startWebBridge({
  pubsub,
  listGuilds: createGuildList(client),
  listChannels: createGuildChannelList(client),
  archive: createArchiveControl({
    settings: archiveSettings,
    policy: archivePolicy,
    backfill: createArchiveBackfill({
      history: createChannelHistory(client),
      policy: archivePolicy,
      archive: messageArchive,
    }),
  }),
  reading: {
    channelMessages: createChannelReader(client, resolveNames),
    dmList: createDmList(client),
    resolveNames,
  },
  writing: createWriting({ client, uploads, logger: logger.child({ component: "web-writing" }) }),
  // The same player instance the music module drives, so both panels show one state.
  music: createWebMusic({
    player: musicPlayer,
    voice: createVoiceDirectory(client),
    botUserId: () => client.user?.id ?? null,
    parseQuery,
    logger: logger.child({ component: "web-music" }),
  }),
  botStatus: () => ({ guilds: client.guilds.cache.size, startedAt }),
  logger: logger.child({ component: "web-bridge" }),
});
// Live music state for the panel (#148): every change of a guild's player, and the node coming or going.
const musicEvents = startMusicEvents({ player: musicPlayer, publish: webBridge.publishEvent });
// The panel's live view (#146): every message event goes out, the panel keeps only what a socket watches.
attachMessageEvents(client, {
  publish: webBridge.publishEvent,
  resolve: resolveNames,
  logger: logger.child({ component: "web-events" }),
});

client.once(Events.ClientReady, (ready) => {
  void webBridge.onReady();
  logger.info("Logged in", {
    app: env.DISCORD_APP,
    user: ready.user.tag,
    guilds: ready.guilds.cache.size,
    commands: registry.commands().length,
  });
  if (env.COMMANDS_AUTO_DEPLOY) {
    void deployOnStartup({
      rest: client.rest,
      clientId: env.DISCORD_CLIENT_ID,
      devGuildId: env.DISCORD_DEV_GUILD_ID,
      global: env.DEPLOY_GLOBAL,
      registry,
      logger: logger.child({ component: "deploy" }),
    });
  }
});
// A rejected promise nobody awaited (a failed Discord call in a listener) is logged, not fatal.
process.on("unhandledRejection", (reason) =>
  logger.error("Unhandled rejection", { error: reason }),
);
// Unlike a rejection, a thrown error nobody caught leaves the process in an unknown state: log it and exit
// so the container's restart policy brings up a clean instance.
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});
client.on(Events.Error, (error) => logger.error("Discord client error", { error }));

let healthServer: ReturnType<typeof startHealthServer> | undefined;
if (env.HEALTH_PORT !== 0) {
  try {
    healthServer = startHealthServer({
      port: env.HEALTH_PORT,
      hostname: env.HEALTH_HOSTNAME,
      logger: logger.child({ component: "health" }),
      probes: {
        gateway: async () => gatewayReady(client.ws.shards),
        postgres: async () => {
          await sql`select 1`;
          return true;
        },
        redis: () => redisStore.ping(),
      },
    });
  } catch (error) {
    // Port taken or hostname unusable: a bot without a health endpoint beats a bot that does not start.
    logger.warn("Health endpoint could not start; continuing without it", { error });
  }
}

const SHUTDOWN_DEADLINE_MS = 20_000;
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
  // A step that hangs (a gateway that never closes) must not hold the container until it is killed.
  setTimeout(() => {
    logger.error("Shutdown timed out");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  let exitCode = 0;
  try {
    await healthServer?.stop(true);
    clearInterval(uploadSweep);
    musicEvents.stop();
    await webBridge.stop();
    for (const module of modules) {
      try {
        await module.dispose?.();
      } catch (error) {
        exitCode = 1;
        logger.error("Module dispose failed", { module: module.name, error });
      }
    }
    // After the music module removed its panels: leave voice and close the node connection.
    await musicPlayer.destroy().catch((error: unknown) => {
      exitCode = 1;
      logger.error("Music player shutdown failed", { error });
    });
    await client.destroy();
    redis.close();
    redisSubscriber.close();
    await sql.close();
  } catch (error) {
    exitCode = 1;
    logger.error("Shutdown failed", { error });
  } finally {
    process.exit(exitCode);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(env.DISCORD_TOKEN);
