import type { AnyCommand, OptionDef, OptionType } from "@dzajcarz/core";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
} as const satisfies Record<OptionType, ApplicationCommandOptionType>;

type OptionJSON = NonNullable<RESTPostAPIChatInputApplicationCommandsJSONBody["options"]>[number];

/** The body Discord expects when registering a command as a slash command. */
export function toSlashCommand(
  command: AnyCommand,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const guildOnly = command.guildOnly || command.permissions !== undefined;
  return {
    type: ApplicationCommandType.ChatInput,
    name: command.name,
    description: command.description,
    options: Object.entries(command.options ?? {}).map(([name, option]) => toOption(name, option)),
    integration_types: [ApplicationIntegrationType.GuildInstall],
    contexts: guildOnly
      ? [InteractionContextType.Guild]
      : [InteractionContextType.Guild, InteractionContextType.BotDM],
    // Hides the command from members without the permission; executeCommand still checks it.
    default_member_permissions:
      command.permissions === undefined ? undefined : command.permissions.toString(),
  };
}

function toOption(name: string, option: OptionDef): OptionJSON {
  const base = {
    name,
    description: option.description,
    required: option.required ?? false,
  };
  switch (option.type) {
    case "string":
      return {
        ...base,
        type: ApplicationCommandOptionType.String,
        choices: option.choices?.map((c) => ({ name: c.name, value: String(c.value) })),
      };
    case "integer":
      return {
        ...base,
        type: ApplicationCommandOptionType.Integer,
        min_value: option.minValue,
        max_value: option.maxValue,
        choices: option.choices?.map((c) => ({ name: c.name, value: Number(c.value) })),
      };
    case "number":
      return {
        ...base,
        type: ApplicationCommandOptionType.Number,
        min_value: option.minValue,
        max_value: option.maxValue,
        choices: option.choices?.map((c) => ({ name: c.name, value: Number(c.value) })),
      };
    default:
      return { ...base, type: OPTION_TYPES[option.type] };
  }
}
