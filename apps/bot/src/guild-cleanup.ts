import type { Logger } from "@dzajcarz/core";
import type { GuildDataRepository } from "@dzajcarz/db";

/**
 * Handles `guildDelete`: the bot was kicked or the server deleted. Everything stored for it goes, so a server
 * that adds the bot again starts fresh. An outage is `guildUnavailable` in discord.js and never reaches this.
 */
export function createGuildCleanup(guildData: GuildDataRepository, logger: Logger) {
  return async (guild: { id: string }): Promise<void> => {
    try {
      const removed = await guildData.forget(guild.id);
      logger.info("Removed the data of a server the bot left", { guildId: guild.id, removed });
    } catch (error) {
      logger.error("Could not remove the data of a server the bot left", {
        guildId: guild.id,
        error,
      });
    }
  };
}
