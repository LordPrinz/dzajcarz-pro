import type { DzajCommand } from '@/core/commander';

export default {
  description: 'Test command to simulate a member join',
  type: 'both',
  testOnly: true,
  ownerOnly: true,

  callback({ client, member }) {
    client.emit('guildMemberAdd', member!);
    return 'Simulated a member join event';
  },
} as DzajCommand;
