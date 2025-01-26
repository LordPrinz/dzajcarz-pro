import type { DzajCommander } from '@/core/commander';
import { database } from '@/lib/db';
import type { CategoryChannel } from 'discord.js';

export default async (instance: DzajCommander) => {
  (await instance.getClient().guilds.fetch()).forEach(async (guild) => {
    const partyAreas = await database.getServerPartyAreas(guild.id)!;

    for (const partyArea of partyAreas) {
      if (!partyArea) {
        return;
      }

      const detailedGuild = await guild.fetch();
      const category = await detailedGuild.channels.fetch(partyArea.categoryId);
      const splitChannel = await detailedGuild.channels.fetch(partyArea.splitChannelId);
      const commandChannel = partyArea.commandChannelId ? await detailedGuild.channels.fetch(partyArea.commandChannelId) : null;

      if (!category) {
        return;
      }

      if (!splitChannel) {
        return;
      }

      await database.saveSplitChannelToCache(guild.id, splitChannel.id);

      if (commandChannel) {
        await database.saveCommandChannel(guild.id, commandChannel.id);
      }

      await database.savePartyChannel(guild.id, category.id);

      (category as CategoryChannel).children.cache.forEach(async (channel) => {
        if (channel.id !== splitChannel?.id && channel.id !== commandChannel?.id) {
          await database.addCustomVoiceChannel(guild.id, channel.id);
        }
      });
    }
  });
};
