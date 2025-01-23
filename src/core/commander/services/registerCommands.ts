import {
  ApplicationCommandType,
  MessageFlags,
  type ApplicationCommandOption,
  type Client,
  type CommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextBasedChannel,
  type User,
} from 'discord.js';
import { getCommandsMap } from '../utils/fs';
import type { DzajCommander } from '..';
import { sql } from 'bun';

export type DzajCommand = {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  callback: (commandUsage: CommandUsage) => unknown;
  type: 'legacy' | 'slash' | 'both';
  init?: () => void;
  description?: string;
  aliases?: string[];
  guildOnly?: boolean;
  ownerOnly?: boolean;
  permissions?: bigint[];
  deferReply?: 'ephemeral' | boolean;
  minArgs?: number;
  maxArgs?: number;
  correctSyntax?: string;
  expectedArgs?: string;
  options?: ApplicationCommandOption[];
  autocomplete?: () => void;
  reply?: boolean;
  delete?: boolean;
};

type CommandUsage = {
  client: Client;
  instance: DzajCommander;
  message?: Message | null;
  interaction?: CommandInteraction | null;
  args: string[];
  text: string;
  guild?: Guild | null;
  member?: GuildMember;
  user: User;
  channel?: TextBasedChannel | null;
  cancelCooldown?: () => void;
  updateCooldown?: () => void;
};
export const registerCommands = async (instance: DzajCommander, commandsDir: string, prefix: string) => {
  const commandsWithCategories = await getCommandsMap(commandsDir);

  const commands = new Map<string, DzajCommand>();

  for (const commandCategory of commandsWithCategories) {
    for (const commandObject of commandCategory[1]) {
      const [commandName, command] = commandObject;
      commands.set(commandName, command);
    }
  }

  [...commands.keys()].forEach(async (commandName) => {
    await sql`INSERT INTO Commands (id) VALUES (${commandName}) ON CONFLICT DO NOTHING;`;
  });

  const slashCommands: Set<string> = new Set();
  const legacyCommands: Set<string> = new Set();

  for (const commandObject of commands) {
    const [commandName, command] = commandObject;

    if (command.init) {
      command.init();
    }

    if (command.delete) {
      const guilds = instance.getClient().guilds.cache;
      for (const guild of guilds.values()) {
        const commandToDelete = await guild.commands.cache.find((cmd) => cmd.name === commandName);
        if (commandToDelete) {
          await guild.commands.delete(commandToDelete.id);
        }
      }
    }

    if (command.type === 'both' || command.type === 'legacy') {
      legacyCommands.add(commandName);
    }

    if (command.type === 'both' || command.type === 'slash') {
      slashCommands.add(commandName);
    }
  }

  instance.getClient().on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (!message.content.startsWith(prefix)) {
      return;
    }

    const args = message.content.split(' ');
    const commandName = args[0].toLowerCase().replace(prefix, '');

    if (!commandName) return;

    const command = commands.get(commandName);
    if (!command) return;

    if (command.ownerOnly && !instance.getOwnersIds().includes(message.author.id)) {
      return message.reply('This command can only be used by the bot owner.');
    }

    if (command.guildOnly && !message.guild) {
      return message.reply('This command can only be used within a server.');
    }

    if (command.permissions && !message.member?.permissions.has(command.permissions)) {
      return message.reply('You do not have permission to use this command.');
    }

    const commandUsage: CommandUsage = {
      client: instance.getClient(),
      message,
      instance,
      args: args.slice(1),
      text: message.content,
      user: message.author,
      channel: message.channel,
      interaction: null,
    };

    const msg = await command.callback(commandUsage);

    if (msg) {
      await message.reply(msg);
    }
  });

  instance
    .getClient()
    .guilds.fetch()
    .then((guilds) => {
      const commandsToRegister: any = [];

      slashCommands.forEach(async (commandName) => {
        commandsToRegister.push({
          name: commandName,
          description: commands.get(commandName)?.description || '',
          options: commands.get(commandName)?.options || [],
          type: ApplicationCommandType.ChatInput,
        });
      });

      guilds.forEach(async (guild) => {
        const detaliedGuild = await guild.fetch();
        await detaliedGuild.commands.set(commandsToRegister).then((createdCommands) => {
          console.log(`Registered ${createdCommands.size} commands in ${detaliedGuild.name}`);
        });
      });
    });

  instance.getClient().on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    if (command.ownerOnly && !instance.getOwnersIds().includes(interaction.user.id)) {
      return interaction.reply({ content: 'This command can only be used by the bot owner.', flags: MessageFlags.Ephemeral });
    }

    if (command.guildOnly && !interaction.guild) {
      return interaction.reply({ content: 'This command can only be used within a server.', flags: MessageFlags.Ephemeral });
    }

    if (command.permissions) {
      const member = interaction.member as GuildMember;
      if (!member.permissions.has(command.permissions)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
      }
    }

    const commandUsage: CommandUsage = {
      client: instance.getClient(),
      interaction,
      instance,
      args: interaction.options.data.map((option) => option.value) as string[],
      text: interaction.commandName,
      user: interaction.user,
      channel: interaction.channel,
      message: null,
    };

    const msg = await command.callback(commandUsage);

    if (msg) {
      await interaction.reply(msg);
    }
  });
};
