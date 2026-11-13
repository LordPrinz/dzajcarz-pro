import {
  type AnyCommand,
  type CommandPlace,
  DEFAULT_CONTEXTS,
  DEFAULT_LOCALE,
  DISCORD_LOCALES,
  type InstallType,
  LOCALES,
  type Localized,
  localize,
  type OptionDef,
  type OptionsDef,
  type OptionType,
} from "@dzajcarz/core";
import {
  type APIApplicationCommandBasicOption,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type LocalizationMap,
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

const INSTALL_TYPES = {
  guild: ApplicationIntegrationType.GuildInstall,
  user: ApplicationIntegrationType.UserInstall,
} as const satisfies Record<InstallType, ApplicationIntegrationType>;

const PLACES = {
  guild: InteractionContextType.Guild,
  "bot-dm": InteractionContextType.BotDM,
  "private-channel": InteractionContextType.PrivateChannel,
} as const satisfies Record<CommandPlace, InteractionContextType>;

type OptionJSON = NonNullable<RESTPostAPIChatInputApplicationCommandsJSONBody["options"]>[number];

/**
 * The text in the default language plus Discord's localizations for every other client language the bot
 * speaks. A text that is the same everywhere carries no localizations.
 */
function localized(text: Localized): { text: string; localizations?: LocalizationMap } {
  const base = localize(text, DEFAULT_LOCALE);
  if (typeof text === "string") return { text: base };
  const localizations: LocalizationMap = {};
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    for (const code of DISCORD_LOCALES[locale]) {
      localizations[code as keyof LocalizationMap] = text[locale];
    }
  }
  return { text: base, localizations };
}

function descriptionOf(text: Localized) {
  const { text: description, localizations } = localized(text);
  return { description, description_localizations: localizations };
}

function choice<V extends string | number>(name: Localized, value: V) {
  const { text, localizations } = localized(name);
  return { name: text, name_localizations: localizations, value };
}

/**
 * The body Discord expects when registering a command as a slash command. A guild-scoped command
 * (`scope: "guild"`, the dev guild deploy) cannot be used in DMs or installed on a user, so Discord gets
 * neither `integration_types` nor `contexts` for it.
 */
export function toSlashCommand(
  command: AnyCommand,
  scope: "global" | "guild" = "global",
): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const contexts = command.contexts ?? DEFAULT_CONTEXTS;
  return {
    type: ApplicationCommandType.ChatInput,
    name: command.name,
    ...descriptionOf(command.description),
    options: command.subcommands
      ? Object.entries(command.subcommands).map(([name, subcommand]) => ({
          type: ApplicationCommandOptionType.Subcommand as const,
          name,
          ...descriptionOf(subcommand.description),
          options: toOptions(subcommand.options) as APIApplicationCommandBasicOption[],
        }))
      : toOptions(command.options),
    ...(scope === "global" && {
      integration_types: contexts.installs.map((install) => INSTALL_TYPES[install]),
      contexts: contexts.places.map((place) => PLACES[place]),
    }),
    // Discord applies this only to commands used in servers (it hides them from members without the
    // permission); the registry keeps permissioned commands out of DMs and the user install, and
    // executeCommand checks the permission anyway.
    default_member_permissions:
      command.permissions === undefined ? undefined : command.permissions.toString(),
  };
}

function toOptions(options: OptionsDef = {}) {
  return Object.entries(options)
    .filter(([, option]) => !option.prefixOnly)
    .map(([name, option]) => toOption(name, option));
}

function toOption(name: string, option: OptionDef): OptionJSON {
  const base = {
    name,
    ...descriptionOf(option.description),
    required: option.required ?? false,
  };
  switch (option.type) {
    case "string":
      return {
        ...base,
        type: ApplicationCommandOptionType.String,
        choices: option.choices?.map((c) => choice(c.name, String(c.value))),
      };
    case "integer":
      return {
        ...base,
        type: ApplicationCommandOptionType.Integer,
        min_value: option.minValue,
        max_value: option.maxValue,
        choices: option.choices?.map((c) => choice(c.name, Number(c.value))),
      };
    case "number":
      return {
        ...base,
        type: ApplicationCommandOptionType.Number,
        min_value: option.minValue,
        max_value: option.maxValue,
        choices: option.choices?.map((c) => choice(c.name, Number(c.value))),
      };
    default:
      return { ...base, type: OPTION_TYPES[option.type] };
  }
}
