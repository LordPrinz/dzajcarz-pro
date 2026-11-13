/**
 * The languages the bot speaks. Polish is the default: the bot was written for a Polish group, and a server
 * or member that never chose a language keeps getting what it always got.
 */
export const LOCALES = ["pl", "en", "de"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pl";

/** The name of each language in that language, for `/language` and its choices. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  pl: "Polski",
  en: "English",
  de: "Deutsch",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Member-facing text that is either the same in every language (a name, an emoji, a URL) or written once
 * per language.
 */
export type Localized = string | Readonly<Record<Locale, string>>;

export function localize(text: Localized, locale: Locale): string {
  return typeof text === "string" ? text : text[locale];
}

/** Every spelling of a `Localized`, e.g. so the prefix parser accepts a choice name in any language. */
export function allLocalizations(text: Localized): string[] {
  return typeof text === "string" ? [text] : LOCALES.map((locale) => text[locale]);
}

/** The Discord locales each of ours is published under in command localizations. */
export const DISCORD_LOCALES: Readonly<Record<Locale, readonly string[]>> = {
  pl: ["pl"],
  en: ["en-US", "en-GB"],
  de: ["de"],
};

/** Discord's client locale (`pl`, `en-US`, `de`) as one of ours, or null for a language the bot does not speak. */
export function fromDiscordLocale(code: string | null | undefined): Locale | null {
  if (!code) return null;
  for (const locale of LOCALES) {
    if (DISCORD_LOCALES[locale].includes(code)) return locale;
  }
  return null;
}

type Message = string | ((...args: never[]) => string);
type Catalog = Record<string, Message>;

/** The same keys as the Polish catalog, each a string or a function taking the same arguments. */
export type Translation<C extends Catalog> = {
  readonly [K in keyof C]: C[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : string;
};

/** Keys of the entries that are plain strings (not functions). */
type TextKeys<C extends Catalog> = { [K in keyof C]: C[K] extends string ? K : never }[keyof C];

export interface Messages<C extends Catalog> {
  /** The catalog in one language. */
  (locale: Locale): Translation<C>;
  /** A plain-text entry in every language: a `Localized` for descriptions, choice names and modal labels. */
  all(key: TextKeys<C>): Readonly<Record<Locale, string>>;
}

/**
 * A module's member-facing texts in every language. The Polish catalog defines the keys and the arguments
 * of each message; the typecheck fails when another language misses a key, has an extra one or takes
 * different arguments.
 *
 * ```ts
 * const t = defineMessages({
 *   pl: { description: "Puszcza muzykę", queued: (title: string) => `Dodano ${title}.` },
 *   en: { description: "Plays music", queued: (title) => `Queued ${title}.` },
 *   de: { description: "Spielt Musik", queued: (title) => `${title} hinzugefügt.` },
 * });
 * defineCommand({ name: "play", description: t.all("description"), ... });
 * await ctx.reply(t(ctx.locale).queued(title));
 * ```
 */
export function defineMessages<const C extends Catalog>(
  catalogs: { readonly pl: C } & { readonly [L in Exclude<Locale, "pl">]: Translation<C> },
): Messages<C> {
  const messages = (locale: Locale) => catalogs[locale] as Translation<C>;
  messages.all = (key: TextKeys<C>) => {
    const text = (locale: Locale) => (catalogs[locale] as Record<keyof C, string>)[key];
    return { pl: text("pl"), en: text("en"), de: text("de") };
  };
  return messages;
}

/**
 * The language of a server or a member, for text sent outside a command (events, cron jobs, DMs the bot
 * starts). A command's own replies use `ctx.locale` instead.
 */
export interface LocaleResolver {
  /** The server's language; `DEFAULT_LOCALE` when it never chose one. */
  guild(guildId: string): Promise<Locale>;
  /** The member's own language for direct messages; `DEFAULT_LOCALE` when they never chose one. */
  user(userId: string): Promise<Locale>;
}
