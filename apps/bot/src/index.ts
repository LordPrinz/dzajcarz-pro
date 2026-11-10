// Composition root: creates the real adapters once and hands them to the modules.
import {
  createCronScheduler,
  createJsonLogger,
  createRegistry,
  createScheduler,
} from "@dzajcarz/core";
import {
  createDb,
  createDzajcoRepository,
  createGuildSettingsRepository,
  createModerationRepository,
  createModuleToggleRepository,
  createPartyRepository,
  createScheduledMessageRepository,
  createScheduledSongRepository,
  createWelcomeRepository,
} from "@dzajcarz/db";
import { migrate } from "@dzajcarz/db/migrator";
import { createRedisStore, keepConnected } from "@dzajcarz/kv";
import { DZAJCO_GIF } from "@dzajcarz/module-dzajco";
import { RedisClient } from "bun";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { attachHandlers } from "./bot.ts";
import { deployOnStartup } from "./deploy.ts";
import { createDzajcoResponder } from "./discord/dzajco.ts";
import { createGuildChannels } from "./discord/guild-channels.ts";
import { createInstallLinks } from "./discord/install.ts";
import { createMessageChannels, createScheduledMessageSender } from "./discord/messages.ts";
import { createModerationGuild } from "./discord/moderation.ts";
import { createDirectMessages, createPanelMessages, createVoiceChannels } from "./discord/music.ts";
import {
  createPartyChannels,
  createPartyChat,
  createPartyInvites,
  createPartyPermissions,
} from "./discord/party.ts";
import { createClock, createPresence } from "./discord/presence.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { createScheduleVoice } from "./discord/schedule.ts";
import { createGuildLookup, createTextChannels, createWelcomeSender } from "./discord/welcome.ts";
import { loadEnv } from "./env.ts";
import { createModuleEnabled } from "./event-scope.ts";
import { gatewayReady, startHealthServer } from "./health.ts";
import { runHealthcheck } from "./healthcheck.ts";
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

const guildSettings = createGuildSettingsRepository(sql);
// Scheduled messages convert times in Postgres, whose tzdata can lack a name the runtime accepts.
if (!(await guildSettings.isKnownTimeZone(env.DEFAULT_TIME_ZONE))) {
  logger.error("DEFAULT_TIME_ZONE is unknown to Postgres; pick a current IANA name", {
    zone: env.DEFAULT_TIME_ZONE,
  });
  process.exit(1);
}
const prefixes = createPrefixResolver({
  settings: guildSettings,
  cache: createRedisStore(redis),
  defaultPrefix: env.BOT_PREFIX,
  logger: logger.child({ component: "prefix" }),
});
const timeZones = createTimeZones({
  settings: guildSettings,
  cache: createRedisStore(redis),
  defaultTimeZone: env.DEFAULT_TIME_ZONE,
  logger: logger.child({ component: "time-zone" }),
});

const moduleToggleRepository = createModuleToggleRepository(sql);
const gate = createModuleGate({
  toggles: moduleToggleRepository,
  cache: createRedisStore(redis),
  logger: logger.child({ component: "module-gate" }),
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
const riotStore = createRedisStore(redis);
const riotStats = createRiotStats({
  valorantApiKey: env.RIOT_VALORANT_API_KEY,
  lolApiKey: env.RIOT_LOL_API_KEY,
  cache: riotStore,
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
  partyChat: createPartyChat(client),
  partyInvites: createPartyInvites(client),
  scheduler: createScheduler(),
  partyLock: createRedisStore(redis),
  presence: createPresence(client),
  clock: createClock(),
  musicPlayer,
  voiceChannels: createVoiceChannels(client),
  musicPanels: createPanelMessages(client),
  directMessages: createDirectMessages(client),
  componentState: createRedisStore(redis),
  cron: createCronScheduler(),
  scheduleSettings: createScheduledSongRepository(sql),
  scheduleVoice: createScheduleVoice(client),
  scheduledSongPlayer: createScheduledSongPlayer(musicPlayer),
  scheduledSongs: SCHEDULED_SONGS,
  scheduledSongCron: env.SCHEDULED_SONG_CRON,
  timeZones,
  defaultTimeZone: env.DEFAULT_TIME_ZONE,
  dzajcoSettings: createDzajcoRepository(sql),
  dzajcoResponder: createDzajcoResponder(client, logger.child({ component: "dzajco" }), DZAJCO_GIF),
  dzajcoStore: createRedisStore(redis),
  moderationGuild: createModerationGuild(client),
  moderationLog: createModerationRepository(sql),
  moderationDmLimit: createRedisStore(redis),
  riotStats,
  riotStore,
  scheduledMessages: createScheduledMessageRepository(sql, {
    defaultTimeZone: env.DEFAULT_TIME_ZONE,
  }),
  scheduledMessageSender: createScheduledMessageSender(client),
  guildModuleEnabled: (guildId, module) => gate.isEnabled(guildId, null, module),
  messageLock: createRedisStore(redis),
  messageChannels: createMessageChannels(client),
  logger,
});
const registry = createRegistry(modules);
attachHandlers(client, {
  registry,
  prefixes,
  gate,
  botInGuild,
  cooldowns: createRedisStore(redis),
  logger,
});

client.once(Events.ClientReady, (ready) => {
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

const probeStore = createRedisStore(redis);
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
        redis: () => probeStore.ping(),
      },
    });
  } catch (error) {
    // Port taken or hostname unusable: a bot without a health endpoint beats a bot that does not start.
    logger.warn("Health endpoint could not start; continuing without it", { error });
  }
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
  await healthServer?.stop(true);
  for (const module of modules) {
    try {
      await module.dispose?.();
    } catch (error) {
      logger.error("Module dispose failed", { module: module.name, error });
    }
  }
  // After the music module removed its panels: leave voice and close the node connection.
  await musicPlayer
    .destroy()
    .catch((error: unknown) => logger.error("Music player shutdown failed", { error }));
  await client.destroy();
  redis.close();
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(env.DISCORD_TOKEN);
