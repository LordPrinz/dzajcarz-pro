import type { DzajCommand } from '@/core/commander';
import { ActionRow, Modal, TextInput } from '@/core/components';
import { getTextInputValue } from '@/core/components/TextInput';
import { database } from '@/lib/db';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';

export default {
  description: 'Creates a party area category and channels.',
  type: 'both',
  deferReply: true,
  permissions: [PermissionFlagsBits.ManageChannels],
  guildOnly: true,

  callback: async ({ interaction, guild }) => {
    const categoryNameInput = TextInput({
      customId: 'categoryName',
      label: 'Party area name',
      style: 'short',
      required: true,
      minLength: 1,
      maxLength: 45,
    });

    const categoryNameInputComponent = ActionRow(categoryNameInput);

    const splitChannelNameInput = TextInput({
      customId: 'splitChannelName',
      label: 'Split channel name',
      style: 'short',
      required: true,
      minLength: 1,
      maxLength: 50,
    });

    const splitChannelNameInputComponent = ActionRow(splitChannelNameInput);

    const newChannelNameInput = TextInput({
      customId: 'newChannelName',
      label: 'New channel name (use @ to mention user)',
      style: 'short',
      required: true,
      minLength: 1,
      maxLength: 50,
    });

    const newChannelNameInputComponent = ActionRow(newChannelNameInput);

    const commandChannelNameInput = TextInput({
      customId: 'commandChannelName',
      label: 'Message auto delete after 15 seconds channel',
      style: 'short',
      required: false,
      minLength: 1,
      maxLength: 50,
    });

    const commandChannelNameInputComponent = ActionRow(commandChannelNameInput);

    const { modal, filter } = Modal({
      title: 'Create a party area',
      components: [categoryNameInputComponent, splitChannelNameInputComponent, newChannelNameInputComponent, commandChannelNameInputComponent],
    });

    if (!interaction?.isCommand()) {
      return;
    }
    await interaction.showModal(modal);

    const modalInteraction = await interaction
      .awaitModalSubmit({
        filter,
        time: 1000 * 60 * 3,
      })
      .catch(() => null);

    if (!modalInteraction) {
      return;
    }

    const categoryName = getTextInputValue(modalInteraction, 'categoryName');
    const splitChannelName = getTextInputValue(modalInteraction, 'splitChannelName');
    const newChannelName = getTextInputValue(modalInteraction, 'newChannelName');
    const commandChannelName = getTextInputValue(modalInteraction, 'commandChannelName');

    if (!categoryName || !splitChannelName || !newChannelName) {
      return;
    }

    const newCategoryChannel = await guild!.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
    });

    const splitChannel = await newCategoryChannel.guild.channels.create({
      name: splitChannelName,
      type: ChannelType.GuildVoice,
    });

    await splitChannel.setParent(newCategoryChannel.id);

    if (commandChannelName !== '') {
      const commandChannel = await newCategoryChannel.guild.channels.create({
        name: commandChannelName!,
        type: ChannelType.GuildText,
      });

      await commandChannel.setParent(newCategoryChannel.id);

      await modalInteraction.reply({
        content: 'Party area created!',
        flags: MessageFlags.Ephemeral,
      });

      await database.savePartyArea({
        generationTemplate: newChannelName,
        commandChannelId: commandChannel.id,
        categoryId: newCategoryChannel.id,
        splitChannelId: splitChannel.id,
        guildId: guild!.id,
      });
      return;
    }

    await database.savePartyArea({
      generationTemplate: newChannelName,
      commandChannelId: null,
      categoryId: newCategoryChannel.id,
      splitChannelId: splitChannel.id,
      guildId: guild!.id,
    });
  },
} as DzajCommand;
