import { getRandom } from '@/utils';
import { dzajcoGifUrl, dzajcoRegex as regex } from 'config/bot';
import type { Message } from 'discord.js';

export default async (message: Message) => {
  const { content } = message;

  if (!regex.test(content)) {
    return;
  }

  const randomNumber = getRandom(1, 10);

  if (randomNumber !== 1) {
    return;
  }

  message.react('🥚');
  message.reply(dzajcoGifUrl);
};
