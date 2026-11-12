import type { Logger } from "@dzajcarz/core";
import type { PubSub } from "@dzajcarz/kv";
import {
  type CommandHandlers,
  type CommandResponse,
  createCommandServer,
  type EventName,
  type EventPayload,
  type GuildSummary,
  HEARTBEAT_INTERVAL_MS,
} from "@dzajcarz/web-protocol";

/** The archive commands of the panel (#145). */
export interface ArchiveControl {
  /** Stores the server's settings and refreshes the bot's cached copy. */
  setGuild: CommandHandlers["archive.guild.set"];
  /** Stores the DM switch and refreshes the bot's cached copy. */
  setDm: CommandHandlers["archive.dm.set"];
  backfill: CommandHandlers["archive.backfill"];
}

/** The reading commands of the panel (#146). */
export interface ReadingControl {
  channelMessages: CommandHandlers["channel.messages"];
  dmList: CommandHandlers["dms.list"];
  resolveNames: CommandHandlers["names.resolve"];
}

export interface WebBridgeOptions {
  pubsub: PubSub;
  listGuilds: () => GuildSummary[];
  listChannels: (guildId: string) => CommandResponse<"guilds.channels">;
  archive: ArchiveControl;
  reading: ReadingControl;
  /** What `bot.status` carries; read on every heartbeat. */
  botStatus: () => EventPayload<"bot.status">;
  logger: Logger;
  heartbeatMs?: number;
}

export interface WebBridge {
  /** Publishes `bot.status` now and then every heartbeat interval. Call it once the gateway is ready. */
  onReady(): void;
  /** Fire and forget; never rejects. */
  publishEvent<N extends EventName>(name: N, payload: EventPayload<N>): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The bot's one adapter for the web panel (ADR 9): it answers the panel's commands from discord.js state and
 * announces that the bot is alive. Modules do not know it exists. A subscription that fails is retried when
 * Redis reconnects, so this never blocks the bot's start.
 */
export async function startWebBridge({
  pubsub,
  listGuilds,
  listChannels,
  archive,
  reading,
  botStatus,
  logger,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
}: WebBridgeOptions): Promise<WebBridge> {
  const server = createCommandServer({
    pubsub,
    logger,
    handlers: {
      "guilds.list": async () => listGuilds(),
      "guilds.channels": async ({ guildId }) => listChannels(guildId),
      "archive.guild.set": archive.setGuild,
      "archive.dm.set": archive.setDm,
      "archive.backfill": archive.backfill,
      "channel.messages": reading.channelMessages,
      "dms.list": reading.dmList,
      "names.resolve": reading.resolveNames,
    },
  });
  await server.start();

  let timer: Timer | undefined;
  const beat = () => void server.publishEvent("bot.status", botStatus());

  return {
    onReady() {
      if (timer) return;
      beat();
      timer = setInterval(beat, heartbeatMs);
      timer.unref();
    },
    publishEvent: (name, payload) => server.publishEvent(name, payload),
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await server.stop();
    },
  };
}
