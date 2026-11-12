// Composition root of the web panel: creates the real adapters once and starts the server.
import { createJsonLogger } from "@dzajcarz/core";
import {
  createArchiveSettingsRepository,
  createDb,
  createWebAuditRepository,
  webAuditTableExists,
} from "@dzajcarz/db";
import { createRedisPubSub, createRedisStore, keepConnected } from "@dzajcarz/kv";
import { createBotClient } from "@dzajcarz/web-protocol";
import { RedisClient } from "bun";
import { createAuditor } from "./audit.ts";
import { loadEnv } from "./env.ts";
import { runHealthcheck } from "./healthcheck.ts";
import { loadPage } from "./http/page.ts";
import { attachLive, createLiveState } from "./live.ts";
import { createWebServer } from "./server.ts";

// `web healthcheck` is the container HEALTHCHECK: it needs no database, so it runs before loadEnv.
if (process.argv[2] === "healthcheck") process.exit(await runHealthcheck(Bun.env));

const env = loadEnv();
const logger = createJsonLogger({ level: env.LOG_LEVEL });

const sql = createDb(env.WEB_DATABASE_URL);
// Only the bot migrates: the panel's role may not change the schema. Until the bot has created `web_audit`
// the panel exits non-zero and the restart policy tries again.
try {
  if (!(await webAuditTableExists(sql))) {
    logger.error("The web_audit table is missing; start the bot once so it applies the migrations");
    process.exit(1);
  }
} catch (error) {
  logger.error("Could not reach the database", { error });
  process.exit(1);
}

const page = await loadPage();

const redis = new RedisClient(env.WEB_REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis, logger);
// A subscribed connection accepts nothing but (un)subscribe, so pub/sub gets its own.
const redisSubscriber = new RedisClient(env.WEB_REDIS_URL, { enableOfflineQueue: false });
const pubsub = createRedisPubSub({ publisher: redis, subscriber: redisSubscriber, log: logger });
keepConnected(redisSubscriber, logger, { onConnect: pubsub.resubscribe });

const bot = createBotClient({
  pubsub,
  timeoutMs: env.BOT_REQUEST_TIMEOUT_MS,
  logger: logger.child({ component: "bot-client" }),
});
await bot.start();

const live = createLiveState();
const auditor = createAuditor({
  repository: createWebAuditRepository(sql),
  logger: logger.child({ component: "audit" }),
});

const redisStore = createRedisStore(redis);
const server = Bun.serve({
  ...createWebServer({
    publicOrigin: env.WEB_PUBLIC_ORIGIN,
    port: env.WEB_PORT,
    bot,
    auditor,
    archiveSettings: createArchiveSettingsRepository(sql),
    live,
    probes: {
      postgres: async () => {
        await sql`select 1`;
        return true;
      },
      redis: () => redisStore.ping(),
    },
    logger: logger.child({ component: "http" }),
    page,
  }),
  port: env.WEB_PORT,
  hostname: env.WEB_HOSTNAME,
  development: Bun.env.NODE_ENV !== "production",
});
attachLive(server, bot, live);
logger.info("Web panel listening", { hostname: env.WEB_HOSTNAME, port: server.port });

process.on("unhandledRejection", (reason) =>
  logger.error("Unhandled rejection", { error: reason }),
);
// A thrown error nobody caught leaves the process in an unknown state: log it and exit so the restart
// policy brings up a clean instance.
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});

const SHUTDOWN_DEADLINE_MS = 10_000;
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });
  setTimeout(() => {
    logger.error("Shutdown timed out");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  let exitCode = 0;
  try {
    await server.stop(true);
    await bot.stop();
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
