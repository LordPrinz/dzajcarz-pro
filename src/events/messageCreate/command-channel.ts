import { database } from '@/lib/db';
import { sleep } from 'bun';
import { type Message } from 'discord.js';

export default async (message: Message) => {
  if (message.guild === null) return;

  const isCommandChannel = await database.isCommandChannel(message.guild.id, message.channel.id);

  if (!isCommandChannel) return;

  await sleep(1000 * 16);

  if (message.deletable) {
    await message.delete().catch(() => {
      console.warn('Failed to delete message');
    });
  }
};
