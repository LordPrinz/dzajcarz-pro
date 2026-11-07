// Composition root: creates the real adapters once and hands them to the modules.
import { createJsonLogger, createRegistry } from "@dzajcarz/core";
import {
  createDb,
  createGuildSettingsRepository,
  createModuleToggleRepository,
} from "@dzajcarz/db";
import { createRedisStore, keepConnected } from "@dzajcarz/kv";
import { RedisClient } from "bun";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { attachHandlers } from "./bot.ts";
import { createGuildChannels } from "./discord/guild-channels.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { loadEnv } from "./env.ts";
import { createModuleGate } from "./module-gate.ts";
import { createModuleToggles } from "./module-toggles.ts";
import { createModules } from "./modules.ts";
import { createPrefixResolver } from "./prefix-resolver.ts";
import { createPrefixSettings } from "./prefix-settings.ts";

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
    GatewayIntentBits.DirectMessages,
  ],
  // DM channels are not cached, so without this partial the bot never sees DM messages.
  partials: [Partials.Channel],
  allowedMentions: NO_MENTIONS,
});

const modules = createModules({
  commands: () => registry.summaries(),
  gatewayPing: () => client.ws.ping,
  prefixFor: (guildId) => prefixes.resolve(guildId),
  prefixSettings: createPrefixSettings(guildSettings, prefixes),
  moduleToggles: createModuleToggles(moduleToggleRepository, gate, () =>
    modules.map((module) => module.name),
  ),
  channels: createGuildChannels(client),
  defaultPrefix: env.BOT_PREFIX,
});
const registry = createRegistry(modules);
attachHandlers(client, { registry, prefixes, gate, logger });

client.once(Events.ClientReady, (ready) => {
  logger.info("Logged in", {
    user: ready.user.tag,
    guilds: ready.guilds.cache.size,
    commands: registry.commands().length,
  });
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
  await client.destroy();
  redis.close();
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(env.DISCORD_TOKEN);
