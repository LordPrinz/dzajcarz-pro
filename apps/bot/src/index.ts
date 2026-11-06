// Composition root: creates the real adapters once and hands them to the modules.
import { createJsonLogger, createRegistry } from "@dzajcarz/core";
import { createDb, createGuildSettingsRepository } from "@dzajcarz/db";
import { createRedisStore, keepConnected } from "@dzajcarz/kv";
import { RedisClient } from "bun";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { attachHandlers } from "./bot.ts";
import { NO_MENTIONS } from "./discord/reply.ts";
import { loadEnv } from "./env.ts";
import { createModules } from "./modules.ts";
import { createPrefixResolver } from "./prefix-resolver.ts";

const env = loadEnv();
const logger = createJsonLogger({ level: env.LOG_LEVEL });

const sql = createDb(env.DATABASE_URL);
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);

const prefixes = createPrefixResolver({
  settings: createGuildSettingsRepository(sql),
  cache: createRedisStore(redis),
  defaultPrefix: env.BOT_PREFIX,
  logger: logger.child({ component: "prefix" }),
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

const registry = createRegistry(
  createModules({
    commands: () => registry.summaries(),
    gatewayPing: () => client.ws.ping,
    prefixFor: (guildId) => prefixes.resolve(guildId),
  }),
);
attachHandlers(client, { registry, prefixes, logger });

client.once(Events.ClientReady, (ready) => {
  logger.info("Logged in", {
    user: ready.user.tag,
    guilds: ready.guilds.cache.size,
    commands: registry.commands().length,
  });
});
client.on(Events.Error, (error) => logger.error("Discord client error", { error }));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
  await client.destroy();
  redis.close();
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(env.DISCORD_TOKEN);
