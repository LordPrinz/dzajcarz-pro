import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import type { CategoryChannel} from 'discord.js';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';

export default {
  type: 'slash',
  description: 'Delete a party',
  permissions: [PermissionFlagsBits.ManageChannels],

  options: [
    {
      name: 'party',
      type: ApplicationCommandOptionType.String,
      description: 'Select a party to delete',
      required: true,
      autocomplete: true,
    },
  ],
  expectedArgs: '<party>',
  minArgs: 1,
  deferReply: true,
  autocomplete: async (focusedOption, { interaction }) => {
    const partyAreas = await database.getServerPartyAreas(interaction?.guildId as string);
    const partyAreaNames = (await Promise.all(partyAreas.map((party) => party.categoryId).map(async (id) => interaction?.guild?.channels.fetch(id)))).map(
      (channel) => channel?.name,
    );

    return partyAreaNames
      .filter((service) => service?.toLowerCase().startsWith(focusedOption.toLowerCase()))
      .map((service, index) => ({ name: service, value: partyAreas[index].categoryId }));
  },
  callback: async ({ guild, args, interaction }) => {
    const party = args[0] as string;
    const partyAreas = await database.getServerPartyAreas(guild!.id);

    if (!partyAreas.find((partyArea) => partyArea.categoryId === party)) {
      return { content: `Party <#${party}> doesn't exist`, flags: MessageFlags.Ephemeral };
    }

    guild?.channels.cache.filter((channel) => channel.parentId === party).forEach(async (channel) => channel.delete().catch(() => console.warn('Error deleting channel')));

    const category = guild?.channels.cache.get(party) as CategoryChannel;
    await category?.delete().catch(() => console.warn('Error deleting category'));

    const targetSplitChannelId = partyAreas.find((partyArea) => partyArea.categoryId === party)?.splitChannelId;

    await database.deletePartyArea(guild!.id, targetSplitChannelId);

    if (interaction?.isRepliable()) {
      await interaction.reply({ content: `Deleted party <#${party}>`, flags: MessageFlags.Ephemeral }).catch(() => console.warn('Error sending reply'));
    }
  },
} as DzajCommand;
