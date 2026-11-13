import { characterCount, DEFAULT_LOCALE, type Locale, UserError } from "@dzajcarz/core";
import { INVISIBLE, MAX_NAME_LENGTH, MAX_TEMPLATE_LENGTH, USER_PLACEHOLDER } from "./constants.ts";
import { t } from "./messages.ts";

/**
 * The name of a member's new channel: `{user}` replaced by their display name (whitespace collapsed),
 * cut to Discord's 100 characters, never empty (the language's fallback name when nothing is left).
 */
export function renderChannelName(
  template: string,
  displayName: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const user = displayName.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const rendered = template
    .replaceAll(USER_PLACEHOLDER, () => user)
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...rendered].slice(0, MAX_NAME_LENGTH).join("").trim();
  return cut === "" ? t(locale).fallbackChannelName : cut;
}

/** Throws a UserError with a localized message when the template cannot be used. */
export function validateTemplate(template: string): void {
  if (template.trim() === "") throw new UserError((l) => t(l).templateEmpty);
  if (characterCount(template) > MAX_TEMPLATE_LENGTH) {
    throw new UserError((l) => t(l).templateTooLong(MAX_TEMPLATE_LENGTH));
  }
  if (!template.includes(USER_PLACEHOLDER)) {
    throw new UserError((l) => t(l).templateNeedsUser(USER_PLACEHOLDER, t(l).defaultTemplate));
  }
}

export function validateName(kind: "category" | "join", name: string): string {
  const trimmed = name.trim();
  if (trimmed === "")
    throw new UserError((l) =>
      kind === "category" ? t(l).categoryNameRequired : t(l).joinNameRequired,
    );
  if (characterCount(trimmed) > MAX_NAME_LENGTH) {
    throw new UserError((l) => t(l).nameTooLong(MAX_NAME_LENGTH));
  }
  return trimmed;
}

/**
 * Longest prefix of `text` that fits `max` UTF-16 units (what the modal layer and Discord count) without
 * splitting a surrogate pair.
 */
export function fitModalText(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}
