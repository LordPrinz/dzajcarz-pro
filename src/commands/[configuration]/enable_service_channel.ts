import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { services as dzajcarzServices } from 'config/bot';

export default {
  type: 'slash',
  description: 'Manage enabled service channels',
  permissions: [PermissionFlagsBits.ManageChannels],
  options: [
    {
      name: 'service',
      type: ApplicationCommandOptionType.String,
      description: 'Select a service to enable',
      required: true,
      autocomplete: true,
    },
    {
      name: 'channel',
      type: ApplicationCommandOptionType.Channel,
      description: 'Select a channel to enable',
      required: true,
    },
  ],
  deferReply: true,
  expectedArgs: '<service> <channel>',
  minArgs: 2,
  autocomplete: async (focusedOption) => {
    return dzajcarzServices.filter((service) => service.toLowerCase().startsWith(focusedOption.toLowerCase())).map((service) => ({ name: service, value: service }));
  },
  callback: async ({ interaction }) => {
    const service = interaction?.options.get('service')?.value as string;
    const channel = interaction?.options.get('channel')?.value as string;

    if (!dzajcarzServices.includes(service)) {
      return { content: `Service **${service}** is not available`, flags: MessageFlags.Ephemeral };
    }

    await database.enableServiceChannel(interaction?.guildId?.toString() as string, service, channel);

    return { content: `Enabled service **${service}** in channel <#${channel}>`, flags: MessageFlags.Ephemeral };
  },
} as DzajCommand;
