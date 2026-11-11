import type { GuildSummary } from "@dzajcarz/web-protocol";
import type { Client } from "discord.js";

/** The guilds the bot is in, from the client cache, sorted by name. */
export function createGuildList(client: Client): () => GuildSummary[] {
  return () =>
    [...client.guilds.cache.values()]
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL(),
        memberCount: guild.memberCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
}
