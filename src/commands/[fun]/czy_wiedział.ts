import type { DzajCommand } from '@/core/commander';
import { getRandom } from '@/utils';

export default {
  description: 'Answers the damn old question',
  type: 'both',
  guildOnly: true,
  ownerOnly: false,
  callback: async ({ interaction, message, channel }) => {
    const randomNumber = getRandom(0, 1);

    let replyMessage = '';

    if (randomNumber === 0) {
      replyMessage = 'Wiedział!';
    } else {
      replyMessage = 'Nie wiedział sadge bruh';
    }

    if (randomNumber !== 0) {
      return {
        content: replyMessage,
      };
    }

    if (interaction) {
      if (channel?.isSendable()) {
        const reply = await channel.send(replyMessage);
        await reply.react('🙋‍♂️');
        return ':flag_de:';
      }
    }

    if (message) {
      message.react('🙋‍♂️');
    }

    return replyMessage;
  },
} as DzajCommand;
