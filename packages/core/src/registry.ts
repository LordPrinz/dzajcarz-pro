import type { AnyCommand, OptionDef, OptionsDef } from "./command.ts";
import type { AnyEventHandler, BotModule } from "./module.ts";
import { usageLine } from "./prefix.ts";

/** Discord's rule for slash command and option names (lowercase only, since we never localise). */
const NAME_PATTERN = /^[\p{Ll}\p{Lo}\p{N}_-]{1,32}$/u;
const MAX_DESCRIPTION = 100;
const MAX_SUBCOMMANDS = 25;

export interface SubcommandSummary {
  name: string;
  description: string;
  /** Prefix-form syntax without the prefix: `prefix set <value>`. */
  usage: string;
}

export interface CommandSummary {
  name: string;
  description: string;
  aliases: readonly string[];
  module: string;
  /** Empty for a plain command. */
  subcommands: readonly SubcommandSummary[];
}

export interface RegisteredEvent {
  /** Name of the module that owns the handler. */
  module: string;
  handler: AnyEventHandler;
}

export interface CommandRegistry {
  /** Looks up a command by name or prefix alias. */
  find(name: string): AnyCommand | undefined;
  commands(): readonly AnyCommand[];
  events(): readonly RegisteredEvent[];
  /** Name of the module that registered the command (a value returned by `find` or `commands`). */
  moduleOf(command: AnyCommand): string | undefined;
  /** What `/help` shows. */
  summaries(): readonly CommandSummary[];
}

/**
 * Collects commands and event handlers from every module and rejects a broken setup at startup:
 * duplicate names or aliases, names Discord would refuse, required options after optional ones, a
 * command with both or neither of `run` and `subcommands`.
 */
export function createRegistry(modules: readonly BotModule[]): CommandRegistry {
  const byName = new Map<string, { command: AnyCommand; module: string }>();
  const commands: AnyCommand[] = [];
  const events: RegisteredEvent[] = [];
  const owners = new Map<AnyCommand, string>();
  const summaries: CommandSummary[] = [];
  const moduleNames = new Set<string>();

  for (const module of modules) {
    if (moduleNames.has(module.name))
      throw new Error(`Module "${module.name}" is registered twice`);
    moduleNames.add(module.name);

    for (const command of module.commands ?? []) {
      validateCommand(command, module.name);
      for (const key of [command.name, ...(command.aliases ?? [])]) {
        const taken = byName.get(key);
        if (taken) {
          throw new Error(
            `Command name "${key}" from module "${module.name}" is already used by /${taken.command.name} (module "${taken.module}")`,
          );
        }
        byName.set(key, { command, module: module.name });
      }
      commands.push(command);
      owners.set(command, module.name);
      summaries.push({
        name: command.name,
        description: command.description,
        aliases: command.aliases ?? [],
        module: module.name,
        subcommands: Object.entries(command.subcommands ?? {}).map(([name, sub]) => ({
          name,
          description: sub.description,
          usage: usageLine(command, name),
        })),
      });
    }
    for (const handler of module.events ?? []) events.push({ module: module.name, handler });
  }

  return {
    find: (name) => byName.get(name.toLowerCase())?.command,
    commands: () => commands,
    events: () => events,
    summaries: () => summaries,
    moduleOf: (command) => owners.get(command),
  };
}

function validateCommand(command: AnyCommand, module: string): void {
  const where = `command "${command.name}" (module "${module}")`;
  for (const name of [command.name, ...(command.aliases ?? [])]) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid name "${name}" in ${where}: use 1–32 lowercase letters, digits, - or _`,
      );
    }
  }
  checkDescription(command.description, where);

  const { subcommands } = command;
  if ((command.run === undefined) === (subcommands === undefined)) {
    throw new Error(`${where} needs exactly one of "run" and "subcommands"`);
  }
  if (!subcommands) {
    validateOptions(command.options ?? {}, where);
    return;
  }
  if (command.options) throw new Error(`${where} has subcommands, so options belong on them`);
  const entries = Object.entries(subcommands);
  if (entries.length < 1 || entries.length > MAX_SUBCOMMANDS) {
    throw new Error(`${where} must have 1–${MAX_SUBCOMMANDS} subcommands`);
  }
  for (const [name, subcommand] of entries) {
    const at = `subcommand "${name}" of ${where}`;
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid name for ${at}`);
    checkDescription(subcommand.description, at);
    validateOptions(subcommand.options ?? {}, at);
  }
}

function validateOptions(optionDefs: OptionsDef, where: string): void {
  const options = Object.entries(optionDefs);
  if (options.length > 25) throw new Error(`${where} has more than 25 options`);
  let seenOptional = false;
  options.forEach(([name, option], index) => {
    const at = `option "${name}" of ${where}`;
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid name for ${at}`);
    checkDescription(option.description, at);
    // Slash commands require it; prefix commands need it to map positional arguments.
    if (option.required && seenOptional) {
      throw new Error(`Required ${at} comes after an optional one`);
    }
    if (!option.required) seenOptional = true;
    if (option.rest && (option.type !== "string" || index !== options.length - 1)) {
      throw new Error(`"rest" is allowed only on the last option, of type string: ${at}`);
    }
    validateChoicesAndRange(option, at);
  });
}

const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

/** Limits Discord enforces only at deploy time, checked at startup instead. */
function validateChoicesAndRange(option: OptionDef, at: string): void {
  const { choices, minValue, maxValue } = option;
  if (choices) {
    if (!["string", "integer", "number"].includes(option.type)) {
      throw new Error(`Choices are allowed only on string, integer and number options: ${at}`);
    }
    if (choices.length < 1 || choices.length > MAX_CHOICES) {
      throw new Error(`${at} must have 1–${MAX_CHOICES} choices`);
    }
    for (const choice of choices) {
      const length = String(choice.value).length;
      if (
        choice.name.length < 1 ||
        choice.name.length > MAX_CHOICE_LENGTH ||
        length > MAX_CHOICE_LENGTH
      ) {
        throw new Error(
          `Choice "${choice.name}" of ${at} must be 1–${MAX_CHOICE_LENGTH} characters`,
        );
      }
      if (option.type !== "string" && typeof choice.value !== "number") {
        throw new Error(`Choice "${choice.name}" of ${at} must have a number value`);
      }
    }
  }
  if (
    (minValue !== undefined || maxValue !== undefined) &&
    option.type !== "integer" &&
    option.type !== "number"
  ) {
    throw new Error(`minValue / maxValue are allowed only on integer and number options: ${at}`);
  }
  if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) {
    throw new Error(`minValue is greater than maxValue: ${at}`);
  }
}

function checkDescription(description: string, where: string): void {
  if (description.length < 1 || description.length > MAX_DESCRIPTION) {
    throw new Error(`Description of ${where} must be 1–${MAX_DESCRIPTION} characters`);
  }
}
