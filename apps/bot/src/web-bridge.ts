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
import type { MusicHandlers } from "./web-music.ts";

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

/** The commands that write as the bot (#147), one handler per command. */
export type WritingControl = Pick<
  CommandHandlers,
  | "channel.info"
  | "message.send"
  | "message.edit"
  | "message.delete"
  | "reaction.add"
  | "reaction.remove"
  | "members.search"
  | "dm.open"
>;

export interface WebBridgeOptions {
  pubsub: PubSub;
  listGuilds: () => GuildSummary[];
  listChannels: (guildId: string) => CommandResponse<"guilds.channels">;
  archive: ArchiveControl;
  reading: ReadingControl;
  writing: WritingControl;
  /** The music commands (#148), on the player the music module uses. */
  music: MusicHandlers;
  /** What `bot.status` carries; read on every heartbeat. */
  botStatus: () => EventPayload<"bot.status">;
  logger: Logger;
  heartbeatMs?: number;
}

export interface WebBridge {
  /**
   * Starts answering the panel's commands and publishes `bot.status` now and then every heartbeat interval.
   * Call it once the gateway is ready: until then nobody listens, so the panel gets "unavailable" at once.
   */
  onReady(): Promise<void>;
  /** Fire and forget; never rejects. */
  publishEvent<N extends EventName>(name: N, payload: EventPayload<N>): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The bot's one adapter for the web panel (ADR 9): it answers the panel's commands from discord.js state and
 * announces that the bot is alive. Modules do not know it exists. It subscribes on `onReady`, and a
 * subscription that fails is retried when Redis reconnects, so this never blocks the bot's start.
 */
export async function startWebBridge({
  pubsub,
  listGuilds,
  listChannels,
  archive,
  reading,
  writing,
  music,
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
      ...writing,
      ...music,
    },
  });

  let timer: Timer | undefined;
  const beat = () => void server.publishEvent("bot.status", botStatus());

  return {
    async onReady() {
      if (timer) return;
      timer = setInterval(beat, heartbeatMs);
      timer.unref();
      await server.start();
      beat();
    },
    publishEvent: (name, payload) => server.publishEvent(name, payload),
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await server.stop();
    },
  };
}
