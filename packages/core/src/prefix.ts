import type { AnyCommand, OptionDef, OptionsDef } from "./command.ts";

export const MAX_PREFIX_LENGTH = 5;

/**
 * Why a command prefix is unusable, or null when it is fine: 1-5 characters, no whitespace or invisible
 * characters (a zero-width space would look like an empty prefix), no backtick (the prefix is echoed inside
 * code spans, where it would close the span). One rule for `/prefix` and `BOT_PREFIX`.
 */
export function prefixProblem(prefix: string): "length" | "whitespace" | "backtick" | null {
  const length = [...prefix].length;
  if (length < 1 || length > MAX_PREFIX_LENGTH) return "length";
  if (/[\s\p{Cf}]/u.test(prefix)) return "whitespace";
  if (prefix.includes("`")) return "backtick";
  return null;
}

export interface PrefixInvocation {
  /** Lowercased command name or alias. */
  name: string;
  /** Everything after the name, untrimmed of inner whitespace. */
  rest: string;
}

/** `!play  never gonna` with prefix `!` → `{ name: "play", rest: "never gonna" }`; null if no command. */
export function matchPrefix(content: string, prefix: string): PrefixInvocation | null {
  if (!prefix || content.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase())
    return null;
  // Word prefixes read naturally with a space ("dz ping"), so whitespace after any prefix is allowed.
  return splitInvocation(content.slice(prefix.length).trimStart());
}

/** `play never gonna` → `{ name: "play", rest: "never gonna" }`; null if it starts with whitespace. */
export function splitInvocation(body: string): PrefixInvocation | null {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(body);
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), rest: (match[2] ?? "").trim() };
}

export type ParseResult =
  | { ok: true; args: Record<string, unknown>; subcommand?: string }
  /** `error` is shown to the caller (Polish). */
  | { ok: false; error: string };

interface Token {
  value: string;
  /** Offset of the token in the input, so a `rest` option can take the raw remainder. */
  start: number;
}

/** Splits on whitespace; "double quotes" keep spaces together, as do „Polish” and “smart” ones. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /"([^"]*)"|„([^”“]*)[”“]|“([^”]*)”|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    tokens.push({ value: match[1] ?? match[2] ?? match[3] ?? match[4] ?? "", start: match.index });
  }
  return tokens;
}

const DECIMAL = /^-?\d+(?:[.,]\d+)?$/;
const TRUE = new Set(["true", "tak", "yes", "y", "on", "1"]);
const FALSE = new Set(["false", "nie", "no", "n", "off", "0"]);
const SNOWFLAKE = String.raw`(\d{17,20})`;
const MENTION: Record<"user" | "channel" | "role", RegExp> = {
  user: new RegExp(`^(?:<@!?${SNOWFLAKE}>|${SNOWFLAKE})$`),
  channel: new RegExp(`^(?:<#${SNOWFLAKE}>|${SNOWFLAKE})$`),
  role: new RegExp(`^(?:<@&${SNOWFLAKE}>|${SNOWFLAKE})$`),
};

/**
 * Maps positional prefix arguments onto the command's options, in declaration order. For a command with
 * subcommands the first word picks the subcommand and the rest is parsed against its options.
 */
export function parsePrefixArgs(command: AnyCommand, input: string): ParseResult {
  const { subcommands } = command;
  if (!subcommands) return parseOptions(command, command.options ?? {}, input);

  const picked = splitInvocation(input);
  if (!picked) return { ok: false, error: `Podaj podkomendę. ${usage(command)}` };
  const subcommand = Object.hasOwn(subcommands, picked.name) ? subcommands[picked.name] : undefined;
  if (!subcommand) {
    // Backticks would close the code span around the echoed word and let it inject markdown.
    const word = picked.name.replaceAll("`", "").slice(0, 32);
    return { ok: false, error: `Nieznana podkomenda \`${word}\`. ${usage(command)}` };
  }
  const parsed = parseOptions(command, subcommand.options ?? {}, picked.rest, picked.name);
  return parsed.ok ? { ...parsed, subcommand: picked.name } : parsed;
}

function parseOptions(
  command: AnyCommand,
  optionDefs: OptionsDef,
  input: string,
  subcommand?: string,
): ParseResult {
  const tokens = tokenize(input);
  const options = Object.entries(optionDefs);
  const args: Record<string, unknown> = {};

  let index = 0;
  for (const [name, option] of options) {
    const token = tokens[index];
    // An empty quoted token ("") carries no value, so a required string counts it as missing.
    if (!token || (option.required && option.type === "string" && token.value === "")) {
      if (option.required) {
        return {
          ok: false,
          error: `Brakuje argumentu \`${name}\`. ${usage(command, subcommand)}`,
        };
      }
      continue;
    }
    if (option.rest) {
      // One quoted token is taken without its quotes; anything longer keeps the raw text.
      args[name] = index === tokens.length - 1 ? token.value : input.slice(token.start).trim();
      index = tokens.length;
      break;
    }
    const value = convert(option, token.value);
    if (!value.ok) return { ok: false, error: `Argument \`${name}\`: ${value.error}` };
    args[name] = value.value;
    index++;
  }

  if (index < tokens.length) {
    return { ok: false, error: `Za dużo argumentów. ${usage(command, subcommand)}` };
  }
  return { ok: true, args };
}

type Converted = { ok: true; value: unknown } | { ok: false; error: string };

function convert(option: OptionDef, raw: string): Converted {
  switch (option.type) {
    case "string":
      return withChoices(option, raw);
    case "integer":
    case "number": {
      // A numeric choice can be picked by its name too ("!volume głośno").
      const named = option.choices?.find((c) => c.name.toLowerCase() === raw.toLowerCase());
      if (named) return { ok: true, value: named.value };
      // Number() would also take "", "0x1f" and "1e3".
      const value = DECIMAL.test(raw) ? Number(raw.replace(",", ".")) : Number.NaN;
      if (!Number.isFinite(value) || (option.type === "integer" && !Number.isSafeInteger(value))) {
        return {
          ok: false,
          error: option.type === "integer" ? "to musi być liczba całkowita" : "to musi być liczba",
        };
      }
      if (option.minValue !== undefined && value < option.minValue) {
        return { ok: false, error: `najmniej ${option.minValue}` };
      }
      if (option.maxValue !== undefined && value > option.maxValue) {
        return { ok: false, error: `najwyżej ${option.maxValue}` };
      }
      return withChoices(option, value);
    }
    case "boolean": {
      const lower = raw.toLowerCase();
      if (TRUE.has(lower)) return { ok: true, value: true };
      if (FALSE.has(lower)) return { ok: true, value: false };
      return { ok: false, error: "wpisz tak albo nie" };
    }
    case "user":
    case "channel":
    case "role": {
      const match = MENTION[option.type].exec(raw);
      const id = match?.[1] ?? match?.[2];
      if (!id) {
        const what = { user: "użytkownika", channel: "kanał", role: "rolę" }[option.type];
        return { ok: false, error: `oznacz ${what} albo podaj jego ID` };
      }
      return { ok: true, value: id };
    }
  }
}

function withChoices(option: OptionDef, value: string | number): Converted {
  if (!option.choices?.length) return { ok: true, value };
  const lower = String(value).toLowerCase();
  const choice = option.choices.find(
    (c) => String(c.value).toLowerCase() === lower || c.name.toLowerCase() === lower,
  );
  if (!choice) {
    return { ok: false, error: `dozwolone: ${option.choices.map((c) => c.value).join(", ")}` };
  }
  return { ok: true, value: choice.value };
}

/**
 * `play <query...> [volume]`, `prefix set <value>` or `prefix set|reset|show`. The "slash" form leaves out
 * `prefixOnly` options, which the slash command does not have.
 */
export function usageLine(
  command: AnyCommand,
  subcommand?: string,
  form: "slash" | "prefix" = "prefix",
): string {
  const { subcommands } = command;
  if (subcommands && !subcommand) return `${command.name} ${Object.keys(subcommands).join("|")}`;
  const options = subcommand ? subcommands?.[subcommand]?.options : command.options;
  const shown = Object.entries(options ?? {}).filter(
    ([, option]) => form === "prefix" || !option.prefixOnly,
  );
  const parts = shown.map(([name, option]) => {
    const label = option.rest ? `${name}...` : name;
    return option.required ? `<${label}>` : `[${label}]`;
  });
  return [command.name, subcommand, ...parts].filter(Boolean).join(" ");
}

/** `Użycie: \`play <query...> [volume]\`` */
export function usage(command: AnyCommand, subcommand?: string): string {
  return `Użycie: \`${usageLine(command, subcommand)}\``;
}
