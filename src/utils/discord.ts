import type { DzajCommand } from '@/core/commander';
import { botOwners } from 'config/bot';
import type { GuildMember } from 'discord.js';

const validateCommandPermissions = (command: DzajCommand, member: GuildMember) => {
  if (command.ownerOnly && !botOwners.includes(member.id)) {
    return false;
  }

  if (!command.permissions) return true;

  for (const permission of command.permissions) {
    if (!member.permissions.has(permission)) {
      return false;
    }
  }

  return true;
};

export const filterCommandsByPermissions = (commands: Map<string, Map<string, DzajCommand>>, member: GuildMember) => {
  const filteredCommands = new Map<string, Map<string, DzajCommand>>();

  for (const [category, commandsMap] of commands) {
    const filteredCommandsMap = new Map<string, DzajCommand>();

    for (const [commandName, command] of commandsMap) {
      if (validateCommandPermissions(command, member)) {
        filteredCommandsMap.set(commandName, command);
      }
    }

    if (filteredCommandsMap.size) {
      filteredCommands.set(category, filteredCommandsMap);
    }
  }

  return filteredCommands;
};
