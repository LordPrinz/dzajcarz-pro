import { dzajcarz } from '@/app';
import type { DzajCommand } from '@/core/commander';
import { getCommandsMap } from '@/core/commander/utils/fs';
import { ActionRow, Embed } from '@/core/components';
import { createStringSelectMenuCollector, StringSelectMenu, type StringSelectOptions } from '@/core/components/select';
import { filterCommandsByPermissions } from '@/utils';
import { authorFooter } from 'config/bot';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

export default {
  description: 'Help command, returns all possible for you commands',
  type: 'both',
  guildOnly: true,
  callback: async ({ interaction, member, guild }) => {
    if (!interaction || !('reply' in interaction)) {
      console.error('Invalid interaction');
      return;
    }

    const commandsWithCategories = await getCommandsMap(dzajcarz.getCommandsDir());

    const filteredCommands = filterCommandsByPermissions(commandsWithCategories, member!);

    const categories = Array.from(filteredCommands.keys());

    const options: StringSelectOptions = categories.map((category) => ({
      label: category,
      value: category,
    }));

    const selectMenu = StringSelectMenu({
      placeholder: 'Select a command category',
      interaction: interaction as ChatInputCommandInteraction,
      options,
    });

    const actionRow = ActionRow(selectMenu);

    const reply = await interaction.reply({
      components: [actionRow],
      flags: MessageFlags.Ephemeral,
    });

    const collector = createStringSelectMenuCollector({
      interaction: interaction as ChatInputCommandInteraction,
      reply,
      time: 1000 * 60 * 5,
    });

    collector.on('collect', async (i) => {
      if (!i.values.length) return;

      const selectedCategory = i.values[0];
      const categoryCommands = filteredCommands.get(selectedCategory);

      if (!categoryCommands || categoryCommands.size === 0) {
        await i.update({
          content: 'No commands found in this category.',
          embeds: [],
          components: [],
        });
        return;
      }

      const embed = Embed({
        title: `${selectedCategory} Commands`,
        description: 'Here is a list of commands in this category:',
        thumbnail: {
          url: guild?.iconURL({ size: 512 }) || '',
        },
        timestamp: new Date(),
        footer: {
          text: authorFooter,
        },
        fields: Array.from(categoryCommands.entries()).map(([commandName, command]) => ({
          name: commandName,
          value: command.description || 'No description available.',
        })),
      }).setColor('Random');

      await i.update({ embeds: [embed] });
    });
  },
} as DzajCommand;
