// Composition root: creates the real adapters once and hands them to the modules.
import {
  createCronScheduler,
  createJsonLogger,
  createRegistry,
  createScheduler,
} from "@dzajcarz/core";
import {
  createDb,
  createGuildSettingsRepository,
  createModuleToggleRepository,
  createPartyRepository,
  createScheduledSongRepository,
  createWelcomeRepository,
} from "@dzajcarz/db";
import { createRedisStore, keepConnected } from "@dzajcarz/kv";
import { RedisClient } from "bun";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { attachHandlers } from "./bot.ts";
import { deployOnStartup } from "./deploy.ts";
import { createGuildChannels } from "./discord/guild-channels.ts";
import { createInstallLinks } from "./discord/install.ts";
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

const env = loadEnv();
const logger = createJsonLogger({ level: env.LOG_LEVEL });

const sql = createDb(env.DATABASE_URL);
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);

const guildSettings = createGuildSettingsRepository(sql);
const prefixes = createPrefixResolver({
  settings: guildSettings,
  cache: createRedisStore(redis),
  defaultPrefix: env.BOT_PREFIX,
  logger: logger.child({ component: "prefix" }),
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

// Without a key the module still loads, so its commands explain that Riot stats are off.
const riotStore = createRedisStore(redis);
const riotStats = env.RIOT_API_KEY
  ? createRiotStats({
      apiKey: env.RIOT_API_KEY,
      cache: riotStore,
      logger: logger.child({ component: "riot" }),
    })
  : null;
if (!env.RIOT_API_KEY) logger.info("RIOT_API_KEY is not set; Riot stats are off");

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
  scheduledSongCron: { expression: env.SCHEDULED_SONG_CRON, timeZone: env.SCHEDULED_SONG_TIMEZONE },
  riotStats,
  riotStore,
  logger,
});
const registry = createRegistry(modules);
attachHandlers(client, { registry, prefixes, gate, botInGuild, logger });

client.once(Events.ClientReady, (ready) => {
  logger.info("Logged in", {
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
client.on(Events.Error, (error) => logger.error("Discord client error", { error }));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
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
