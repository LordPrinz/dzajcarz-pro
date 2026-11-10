/** Scripts written without spaces between words: a hit inside a longer run of text still counts. */
const SPACELESS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}]`;

/**
 * Longest stretch of a message that is searched, after emoji and links are removed; Discord allows 4000 for
 * Nitro and nobody says "what" later.
 */
const MAX_SEARCHED_LENGTH = 2000;

/**
 * NFC lowercase without zero-width spaces, and every run of one character cut down to a single one. Doing
 * that to both words and text is what lets `whaaat` match `what` without a `+` after each letter, which
 * would make the regex quadratic on input like "chiiii…".
 */
function fold(text: string): string {
  return text
    .replaceAll("\u200b", "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/(.)\1+/gsu, "$1");
}

/** Custom emoji and http(s) links carry names and paths ("<:co:1>", "https://x/what") that nobody said. */
function withoutMarkup(text: string): string {
  return text.replace(/<a?:\w+:\d+>/gu, " ").replace(/https?:\/\/\S+/giu, " ");
}

function escapeRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

/**
 * One word as a pattern over its folded form (repeats already collapsed); inner whitespace of any length
 * is allowed (`He   aha`).
 */
function wordPattern(word: string): string {
  const pieces: string[] = [];
  let previousWasSpace = false;
  for (const character of fold(word).trim()) {
    if (/\s/u.test(character)) {
      if (!previousWasSpace) pieces.push(String.raw`\s+`);
      previousWasSpace = true;
    } else {
      pieces.push(escapeRegExp(character));
      previousWasSpace = false;
    }
  }
  return pieces.join("");
}

/**
 * Builds the "does this message say what" test once. A word in a spaced script has to stand alone (no
 * letter, mark or digit right before or after it), so `whatever` does not count; a word in a script
 * without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) counts anywhere in the text.
 */
export function createWhatMatcher(words: readonly string[]): (text: string) => boolean {
  const bounded: string[] = [];
  const spaceless: string[] = [];
  for (const word of words) {
    const pattern = wordPattern(word);
    if (pattern.length === 0) continue;
    (SPACELESS.test(word) ? spaceless : bounded).push(pattern);
  }
  const alternatives: string[] = [];
  if (bounded.length > 0) {
    alternatives.push(`(?<!${WORD_CHAR})(?:${bounded.join("|")})(?!${WORD_CHAR})`);
  }
  if (spaceless.length > 0) alternatives.push(`(?:${spaceless.join("|")})`);
  if (alternatives.length === 0) return () => false;
  const pattern = new RegExp(alternatives.join("|"), "u");
  return (text) =>
    pattern.test(
      fold(withoutMarkup(text.slice(0, 2 * MAX_SEARCHED_LENGTH)).slice(0, MAX_SEARCHED_LENGTH)),
    );
}
