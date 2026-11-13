import { DEFAULT_LOCALE, type Locale } from "./i18n.ts";

/** Text shown to a member: the same in every language, or written per language. */
export type MemberText = string | ((locale: Locale) => string);

/**
 * A failure the caller caused or can fix ("join a voice channel first"). Its text is shown to them as is,
 * so keep internals out. Pass a function (`(l) => t(l).noQueue`) and the dispatcher renders it in the
 * caller's language; `message` holds the Polish text for logs. Any other error is logged and the caller
 * sees a generic message.
 */
export class UserError extends Error {
  override readonly name = "UserError";
  readonly #text: MemberText;

  constructor(text: MemberText) {
    super(typeof text === "string" ? text : text(DEFAULT_LOCALE));
    this.#text = text;
  }

  /** The text in `locale`. */
  messageIn(locale: Locale): string {
    return typeof this.#text === "string" ? this.#text : this.#text(locale);
  }
}
