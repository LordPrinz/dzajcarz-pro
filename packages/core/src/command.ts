/**
 * A command is defined once and runs both as a slash command and as a prefix command (`!ping`).
 * Modules see only `CommandContext`; the Discord adapters in apps/bot translate interactions and
 * messages into it.
 */

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
}

/** Key order is the positional order of prefix arguments. */
export type OptionsDef = Record<string, OptionDef>;

type RequiredKeys<O extends OptionsDef> = {
  [K in keyof O]: O[K]["required"] extends true ? K : never;
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
}

export type Reply =
  | string
  | {
      content?: string;
      embeds?: Embed[];
      /** Slash: only the caller sees it. Prefix: ignored (messages cannot be ephemeral). */
      ephemeral?: boolean;
    };

export type Invocation = "slash" | "prefix";

export interface CommandContext<A = Record<string, unknown>> {
  readonly args: A;
  readonly invocation: Invocation;
  readonly user: { readonly id: string; readonly displayName: string };
  /** null in direct messages. */
  readonly guildId: string | null;
  readonly channelId: string;
  /** Permission bit field of the calling member; null in direct messages. */
  readonly memberPermissions: bigint | null;
  reply(reply: Reply): Promise<void>;
  /** Tells Discord that work is under way (slash: deferred reply, prefix: typing indicator). */
  defer(): Promise<void>;
}

export interface Command<O extends OptionsDef = OptionsDef> {
  /** Lowercase, 1–32 characters: Discord's rule for slash command names. */
  name: string;
  description: string;
  /** Extra names for the prefix form only (`!p` for `!play`). */
  aliases?: readonly string[];
  options?: O;
  /** Refuse to run in direct messages. */
  guildOnly?: boolean;
  /** Discord permission bits (PermissionFlagsBits) the member needs. Implies guildOnly. */
  permissions?: bigint;
  run(ctx: CommandContext<OptionValues<O>>): Promise<void>;
}

/** Type-erased command, as stored in the registry; adapters pass the parsed arguments as a record. */
export type AnyCommand = Omit<Command<OptionsDef>, "run"> & {
  run(ctx: CommandContext): Promise<void>;
};

/** Infers argument types from `options`, so `ctx.args` is fully typed in `run`. */
export function defineCommand<const O extends OptionsDef = Record<never, OptionDef>>(
  command: Command<O>,
): AnyCommand {
  return command as unknown as AnyCommand;
}
