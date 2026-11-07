/**
 * A command is defined once and runs both as a slash command and as a prefix command (`!ping`).
 * Modules see only `CommandContext`; the Discord adapters in apps/bot translate interactions and
 * messages into it.
 */
import type { ComponentRow } from "./component.ts";
import type { ModalSpec } from "./modal.ts";

export type OptionType = "string" | "integer" | "number" | "boolean" | "user" | "channel" | "role";

/** user, channel and role options resolve to the snowflake id. */
type ValueOf<T extends OptionType> = T extends "integer" | "number"
  ? number
  : T extends "boolean"
    ? boolean
    : string;

export interface OptionChoice<V extends string | number = string | number> {
  name: string;
  value: V;
}

export interface OptionDef<T extends OptionType = OptionType> {
  type: T;
  description: string;
  required?: boolean;
  choices?: readonly OptionChoice<ValueOf<T> & (string | number)>[];
  /** integer / number only. */
  minValue?: number;
  maxValue?: number;
  /** string only, last option only: a prefix command passes the rest of the line here. */
  rest?: boolean;
  /**
   * Left out of the slash command, so the prefix form is the only one that takes it. For a command whose
   * slash form collects the same input another way (a modal): `run` must branch on `ctx.canShowModal`
   * before reading the option, because a slash invocation never carries it.
   */
  prefixOnly?: boolean;
}

/** Key order is the positional order of prefix arguments. */
export type OptionsDef = Record<string, OptionDef>;

type RequiredKeys<O extends OptionsDef> = {
  [K in keyof O]: O[K]["required"] extends true
    ? O[K]["prefixOnly"] extends true
      ? never
      : K
    : never;
}[keyof O];

export type OptionValues<O extends OptionsDef> = {
  [K in RequiredKeys<O>]: ValueOf<O[K]["type"]>;
} & {
  [K in Exclude<keyof O, RequiredKeys<O>>]?: ValueOf<O[K]["type"]>;
};

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** The subset of a Discord embed modules use; the adapter maps it to discord.js. */
export interface Embed {
  title?: string;
  description?: string;
  /** 0xRRGGBB */
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  /** Small line above the title: a name with an optional avatar, e.g. who the message comes from. */
  author?: { name: string; iconUrl?: string };
  /** https URL of a picture shown under the text, or `attachment://<name>` of one of the reply's `files`. */
  image?: string;
}

/** A file sent with a message. The adapter uploads the bytes; nothing is fetched from a URL. */
export interface ReplyFile {
  /** File name; an embed refers to it as `attachment://<name>`, so keep it to letters, digits, `.`, `_` and `-`. */
  name: string;
  data: Uint8Array;
}

export type Reply =
  | string
  | {
      content?: string;
      embeds?: Embed[];
      /** Files uploaded with the message. Only adapters that send new messages (direct messages) attach them. */
      files?: ReplyFile[];
      /** Buttons and select menus under the message; their clicks reach `BotModule.components`. */
      components?: ComponentRow[];
      /** Slash: only the caller sees it. Prefix: ignored (messages cannot be ephemeral). */
      ephemeral?: boolean;
    };

export type Invocation = "slash" | "prefix";

export interface CommandContext<A = Record<string, unknown>> {
  readonly args: A;
  readonly invocation: Invocation;
  /** Name of the chosen subcommand; undefined for a plain command. */
  readonly subcommand?: string;
  readonly user: { readonly id: string; readonly displayName: string };
  /** null in direct messages. */
  readonly guildId: string | null;
  /**
   * Where the call came from. Exact: a DM with the bot and a group DM are different places, and both have
   * a null guildId. A prefix message is `guild` or `bot-dm`.
   */
  readonly place: CommandPlace;
  readonly channelId: string;
  /** Permission bit field of the calling member; null in direct messages. */
  readonly memberPermissions: bigint | null;
  reply(reply: Reply): Promise<void>;
  /**
   * Tells Discord that work is under way (slash: deferred reply, prefix: typing indicator). `ephemeral`
   * fixes the visibility of the later reply on slash; prefix ignores it.
   */
  defer(options?: { ephemeral?: boolean }): Promise<void>;
  /** True for slash invocations; a prefix message has no interaction to answer with a modal. */
  readonly canShowModal: boolean;
  /**
   * Opens a modal (`modal.build(ctx.user.id)`) as the answer to the command; it must be the first answer.
   * Throws on a prefix invocation, so check `canShowModal` and fall back to the argument form.
   */
  showModal(modal: ModalSpec): Promise<void>;
}

/** Where a command can be used: a server, a direct message with the bot, or another private channel (group DM). */
export type CommandPlace = "guild" | "bot-dm" | "private-channel";
/** How the bot reached the user: added to a server, or added to the user's own account. */
export type InstallType = "guild" | "user";

export interface CommandContexts {
  places: readonly CommandPlace[];
  installs: readonly InstallType[];
}

/** What a command gets without a `contexts` field: servers only, for a bot added to the server. */
export const DEFAULT_CONTEXTS: CommandContexts = { places: ["guild"], installs: ["guild"] };

interface CommandBase {
  /** Lowercase, 1–32 characters: Discord's rule for slash command names. */
  name: string;
  description: string;
  /** Extra names for the prefix form only (`!p` for `!play`). */
  aliases?: readonly string[];
  /**
   * Where the command runs and which installs it is offered to (default: guild only, guild install). A
   * private channel (group DM) needs the `user` install, because the bot is never a member there.
   */
  contexts?: CommandContexts;
  /** Discord permission bits (PermissionFlagsBits) the member needs. Needs a guild-only command. */
  permissions?: bigint;
}

/** A command that runs directly. */
export interface Command<O extends OptionsDef = OptionsDef> extends CommandBase {
  options?: O;
  run(ctx: CommandContext<OptionValues<O>>): Promise<void>;
}

/** One action of a command (`/prefix set`). Its permissions are checked on top of the command's. */
export interface Subcommand<O extends OptionsDef = OptionsDef> {
  description: string;
  options?: O;
  /** Extra permission bits, checked when the subcommand runs (Discord only gates the whole command). */
  permissions?: bigint;
  run(ctx: CommandContext<OptionValues<O>>): Promise<void>;
}

/** A command that only groups subcommands (one level); it has no `options` or `run` of its own. */
export interface CommandWithSubcommands extends CommandBase {
  /** Key = subcommand name, which is also the first word of the prefix form. */
  subcommands: Record<string, AnySubcommand>;
  options?: never;
  run?: never;
}

/** Type-erased subcommand, as stored on a command. */
export type AnySubcommand = Omit<Subcommand<OptionsDef>, "run"> & {
  run(ctx: CommandContext): Promise<void>;
};

/**
 * Type-erased command, as stored in the registry; adapters pass the parsed arguments as a record.
 * The registry rejects a command that has both or neither of `run` and `subcommands`.
 */
export interface AnyCommand extends CommandBase {
  options?: OptionsDef;
  run?(ctx: CommandContext): Promise<void>;
  subcommands?: Record<string, AnySubcommand>;
}

/** Infers argument types from `options`, so `ctx.args` is fully typed in `run`. */
export function defineCommand<const O extends OptionsDef = Record<never, OptionDef>>(
  command: Command<O>,
): AnyCommand;
export function defineCommand(command: CommandWithSubcommands): AnyCommand;
export function defineCommand(command: object): AnyCommand {
  return command as unknown as AnyCommand;
}

/** Like `defineCommand` for one subcommand: `ctx.args` is typed from its own `options`. */
export function defineSubcommand<const O extends OptionsDef = Record<never, OptionDef>>(
  subcommand: Subcommand<O>,
): AnySubcommand {
  return subcommand as unknown as AnySubcommand;
}
