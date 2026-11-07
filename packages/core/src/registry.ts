import {
  type AnyCommand,
  type CommandContexts,
  type CommandPlace,
  DEFAULT_CONTEXTS,
  type InstallType,
  type OptionDef,
  type OptionsDef,
} from "./command.ts";
import {
  type AnyComponent,
  MAX_COMPONENT_PREFIX,
  MAX_SELECT_OPTIONS,
  parseCustomId,
} from "./component.ts";
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
  /** Extra permission bits on top of the command's own. */
  permissions?: bigint;
}

export interface CommandSummary {
  name: string;
  description: string;
  aliases: readonly string[];
  module: string;
  /** Prefix-form syntax without the prefix: `play [query...]`; for a command with subcommands `queue add|clear`. */
  usage: string;
  /** Permission bits the member needs; undefined when any member may run it. */
  permissions?: bigint;
  contexts: CommandContexts;
  /** Empty for a plain command. */
  subcommands: readonly SubcommandSummary[];
}

export interface RegisteredEvent {
  /** Name of the module that owns the handler. */
  module: string;
  handler: AnyEventHandler;
}

/** A click matched to the component that handles it. */
export interface ResolvedComponent {
  component: AnyComponent;
  /** Name of the module that owns the component. */
  module: string;
  /** Id of the member the component was created for. */
  owner: string;
  /** The `<data>` part of the custom_id. */
  state: string;
}

export interface CommandRegistry {
  /** Looks up a command by name or prefix alias. */
  find(name: string): AnyCommand | undefined;
  commands(): readonly AnyCommand[];
  events(): readonly RegisteredEvent[];
  /** Matches a `custom_id` (`<module>:<component>:<owner>:<data>`) to its handler; undefined if unknown. */
  resolveComponent(customId: string): ResolvedComponent | undefined;
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
  const componentsById = new Map<string, AnyComponent>();

  // The help menu lists the modules in one select menu.
  if (modules.length > MAX_SELECT_OPTIONS) {
    throw new Error(
      `At most ${MAX_SELECT_OPTIONS} modules are supported (the help menu lists them in one select menu), got ${modules.length}`,
    );
  }

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
        usage: usageLine(command),
        permissions: command.permissions,
        contexts: command.contexts ?? DEFAULT_CONTEXTS,
        subcommands: Object.entries(command.subcommands ?? {}).map(([name, sub]) => ({
          name,
          description: sub.description,
          usage: usageLine(command, name),
          permissions: sub.permissions,
        })),
      });
    }
    for (const component of module.components ?? []) {
      validateComponent(component, module.name);
      const id = `${module.name}:${component.name}`;
      if (componentsById.has(id)) throw new Error(`Component "${id}" is registered twice`);
      componentsById.set(id, component);
    }
    for (const handler of module.events ?? []) events.push({ module: module.name, handler });
  }

  return {
    find: (name) => byName.get(name.toLowerCase())?.command,
    commands: () => commands,
    events: () => events,
    summaries: () => summaries,
    resolveComponent(customId) {
      const parsed = parseCustomId(customId);
      const component = parsed && componentsById.get(`${parsed.module}:${parsed.name}`);
      if (!parsed || !component) return undefined;
      return { component, module: parsed.module, owner: parsed.owner, state: parsed.data };
    },
    moduleOf: (command) => owners.get(command),
  };
}

function validateComponent(component: AnyComponent, module: string): void {
  const where = `component "${component.name}" (module "${module}")`;
  if (component.module !== module) {
    throw new Error(`${where} says it belongs to module "${component.module}"`);
  }
  // A colon would shift the fields of the custom_id.
  if (!NAME_PATTERN.test(component.name) || module.includes(":")) {
    throw new Error(
      `Invalid ${where}: use 1–32 lowercase letters, digits, - or _ (no colon in the module name)`,
    );
  }
  if (module.length + component.name.length + 2 > MAX_COMPONENT_PREFIX) {
    throw new Error(`${where}: "<module>:<component>:" is too long for a 100-character custom_id`);
  }
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
  validateContexts(command, where);

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

const PLACES: readonly CommandPlace[] = ["guild", "bot-dm", "private-channel"];
const INSTALLS: readonly InstallType[] = ["guild", "user"];

function validateContexts(command: AnyCommand, where: string): void {
  const { contexts } = command;
  if (!contexts) return;
  if (contexts.places.length < 1 || contexts.installs.length < 1) {
    throw new Error(`${where}: "contexts" needs at least one place and one install type`);
  }
  if (new Set(contexts.places).size !== contexts.places.length) {
    throw new Error(`${where}: duplicate place in contexts`);
  }
  if (new Set(contexts.installs).size !== contexts.installs.length) {
    throw new Error(`${where}: duplicate install type in contexts`);
  }
  for (const place of contexts.places) {
    if (!PLACES.includes(place)) throw new Error(`${where}: unknown place "${place}" in contexts`);
  }
  for (const install of contexts.installs) {
    if (!INSTALLS.includes(install)) {
      throw new Error(`${where}: unknown install type "${install}" in contexts`);
    }
  }
  if (contexts.places.includes("private-channel") && !contexts.installs.includes("user")) {
    throw new Error(`${where}: the "private-channel" place needs the "user" install`);
  }
  if (command.permissions !== undefined && contexts.places.some((place) => place !== "guild")) {
    throw new Error(
      `${where}: "permissions" cannot be checked outside a server; keep it guild-only`,
    );
  }
  const permissioned =
    command.permissions !== undefined ||
    Object.values(command.subcommands ?? {}).some((sub) => sub.permissions !== undefined);
  if (permissioned && contexts.installs.includes("user")) {
    throw new Error(
      `${where}: "permissions" cannot be checked for a user install; keep it guild-install only`,
    );
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
