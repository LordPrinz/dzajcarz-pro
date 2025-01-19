import type { Message } from 'discord.js';

export default (message: Message) => {
  console.log(`[${message.author.tag}] ${message.content}`);
};
