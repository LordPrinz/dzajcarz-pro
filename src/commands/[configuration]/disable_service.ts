import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';

export default {
  type: 'slash',
  description: 'Manage disabled services',
  permissions: [PermissionFlagsBits.ManageChannels],

  options: [
    {
      name: 'service',
      type: ApplicationCommandOptionType.String,
      description: 'Select a service to disable',
      required: true,
      autocomplete: true,
    },
  ],
  expectedArgs: '<service>',
  deferReply: true,
  minArgs: 1,
  autocomplete: async (focusedOption, { interaction }) => {
    const services = await database.getEnabledServices(interaction?.guildId?.toString() as string);
    return services.filter((service) => service.toLowerCase().startsWith(focusedOption.toLowerCase())).map((service) => ({ name: service, value: service }));
  },
  callback: async ({ interaction }) => {
    const service = interaction?.options.get('service')?.value as string;

    const services = await database.getEnabledServices(interaction?.guildId?.toString() as string);

    if (!services.includes(service)) {
      return { content: `Service **${service}** is not enabled or doesn't exist`, flags: MessageFlags.Ephemeral };
    }

    await database.disableService(interaction?.guildId?.toString() as string, service);

    return { content: `Disabled service **${service}**`, flags: MessageFlags.Ephemeral };
  },
} as DzajCommand;
