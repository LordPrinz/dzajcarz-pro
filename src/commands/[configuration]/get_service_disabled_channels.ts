import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { services as dzajcarzServices } from 'config/bot';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';

export default {
  type: 'slash',
  description: 'Manage enabled services',
  permissions: [PermissionFlagsBits.ManageChannels],

  options: [
    {
      name: 'service',
      type: ApplicationCommandOptionType.String,
      description: 'Select a service to enable',
      required: true,
      autocomplete: true,
    },
  ],
  expectedArgs: '<service>',
  minArgs: 1,
  deferReply: true,
  autocomplete: async (focusedOption) => {
    return dzajcarzServices.filter((service) => service.toLowerCase().startsWith(focusedOption.toLowerCase())).map((service) => ({ name: service, value: service }));
  },
  callback: async ({ interaction }) => {
    const service = interaction?.options.get('service')?.value as string;

    const services = await database.getServicePrivileges(interaction?.guildId?.toString() as string, service);

    const channels = services[1];

    return { content: `Disabled channels for service **${service}**:\n${channels.map((channel) => `<#${channel}>`).join('\n')}`, flags: MessageFlags.Ephemeral };
  },
} as DzajCommand;
