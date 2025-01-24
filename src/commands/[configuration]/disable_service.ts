import type { DzajCommand } from '@/core/commander';
import { ApplicationCommandOptionType } from 'discord.js';

const disabledServiceCommand: DzajCommand = {
  type: 'slash',
  description: 'Manage disabled services',
  options: [
    {
      name: 'service',
      type: ApplicationCommandOptionType.String,
      description: 'Select a service to enable/disable',
      required: true,
      autocomplete: true,
    },
  ],
  autocomplete: async (focusedOption) => {
    const services = ['Service A', 'Service B', 'Service C', 'Service D'];
    return services.filter((service) => service.toLowerCase().startsWith(focusedOption.toLowerCase())).map((service) => ({ name: service, value: service }));
  },
  callback: async ({ interaction }) => {
    const service = interaction?.options.get('service')?.value as string;
    return `You selected: ${service}`;
  },
};

export default disabledServiceCommand;
