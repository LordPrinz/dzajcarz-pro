import type { Logger } from "@dzajcarz/core";
import type { GuildDataRepository } from "@dzajcarz/db";

/**
 * Handles `guildDelete`: the bot was kicked or the server deleted. Everything stored for it goes, so a server
 * that adds the bot again starts fresh. An outage is `guildUnavailable` in discord.js and never reaches this.
 * `refreshCaches` then reload the Redis copies (prefix, zone, toggles), which would otherwise serve the old
 * settings for up to 10 minutes to a server that re-adds the bot.
 */
export function createGuildCleanup(
  guildData: GuildDataRepository,
  refreshCaches: readonly ((guildId: string) => Promise<void>)[],
  logger: Logger,
) {
  return async (guild: { id: string }): Promise<void> => {
    try {
      const removed = await guildData.forget(guild.id);
      await Promise.all(refreshCaches.map((refresh) => refresh(guild.id)));
      logger.info("Removed the data of a server the bot left", { guildId: guild.id, removed });
    } catch (error) {
      logger.error("Could not remove the data of a server the bot left", {
        guildId: guild.id,
        error,
      });
    }
  };
}
