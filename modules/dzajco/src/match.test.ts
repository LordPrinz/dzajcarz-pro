import { describe, expect, test } from "bun:test";
import { createWhatMatcher } from "./match.ts";
import { DZAJCO_WORDS, normalizeWords, SOURCE_WORDS } from "./words.ts";

const matches = createWhatMatcher(DZAJCO_WORDS);

describe("word list", () => {
  test("keeps all 111 source entries and removes duplicates after folding", () => {
    expect(SOURCE_WORDS).toHaveLength(111);
    const folded = SOURCE_WORDS.map((word) =>
      word.replaceAll("\u200b", "").normalize("NFC").trim().toLowerCase(),
    );
    expect(DZAJCO_WORDS).toHaveLength(new Set(folded).size);
    expect(DZAJCO_WORDS.length).toBeLessThan(SOURCE_WORDS.length);
    expect(new Set(DZAJCO_WORDS).size).toBe(DZAJCO_WORDS.length);
  });

  test("no entry keeps a zero-width space", () => {
    expect(DZAJCO_WORDS.some((word) => word.includes("\u200b"))).toBe(false);
  });

  test("the Lao entry with a zero-width space collapses into the clean one", () => {
    expect(normalizeWords(["ແມ່ນ\u200bຫຍັງ", "ແມ່ນຫຍັງ"])).toEqual(["ແມ່ນຫຍັງ"]);
  });

  test("short common words stay on the list", () => {
    for (const word of ["me", "co", "que"]) expect(DZAJCO_WORDS).toContain(word);
  });
});

describe("Latin script", () => {
  test.each([
    "what",
    "What?",
    "WHAT!!!",
    "whaaat",
    "so, what is that",
    "co?",
    "cooo",
    "Kto to? co",
    "co <:x:1>",
  ])("%p matches", (text) => expect(matches(text)).toBe(true));

  test.each([
    "whatever",
    "somewhat",
    "cos",
    "komeda",
    "scope",
    "hello there",
    "",
    "<:co:123>",
    "<a:what:456>",
    "https://x/what",
    "HTTPS://x/what",
  ])("%p does not match", (text) => expect(matches(text)).toBe(false));

  test("case and Unicode normalisation are folded", () => {
    expect(matches("QUÉ")).toBe(true);
    expect(matches("qué")).toBe(true);
    // Decomposed forms (base letter + combining mark) must meet the NFC "qué" and "çfarë" of the list.
    expect(matches("QUE\u0301")).toBe(true);
    expect(matches("que\u0301")).toBe(true);
    expect(matches("c\u0327fare\u0308")).toBe(true);
  });

  test("a word glued to letters or digits does not count", () => {
    expect(matches("what1")).toBe(false);
    expect(matches("1what")).toBe(false);
    expect(matches("what_is")).toBe(true);
  });

  test("a word with inner spaces tolerates extra whitespace", () => {
    expect(matches("He   aha")).toBe(true);
    expect(matches("che  cosa")).toBe(true);
    expect(matches("Quid\test")).toBe(true);
  });
});

describe("markup at the search limit", () => {
  test("an emoji cut by the 2000-character boundary is stripped whole, not left as <:co", () => {
    expect(matches(`${"x ".repeat(998)}<:co:123>`)).toBe(false);
  });
});

describe("other scripts with spaces", () => {
  test.each([
    ["Cyrillic", "што"],
    ["Cyrillic uppercase", "ШТО?"],
    ["Greek", "τι;"],
    ["Hebrew", "מה"],
    ["Arabic with extra spaces", "ماذا   او  ما"],
    ["Devanagari", "क्या हुआ"],
    ["Armenian", "ինչ"],
    ["Georgian", "რა"],
    ["Korean", "무엇"],
  ])("%s matches", (_name, text) => expect(matches(text)).toBe(true));

  test("a spaced-script word inside a longer word does not match", () => {
    expect(matches("штофф")).toBe(false);
    expect(matches("מהיר")).toBe(false);
  });
});

describe("scripts written without spaces", () => {
  test.each([
    ["Simplified Han inside a sentence", "你说什么"],
    ["Traditional Han", "你說什麼"],
    ["single Han character", "你想怎么何"],
    ["Thai", "คุณพูดอะไรนะ"],
    ["Lao", "ແມ່ນຫຍັງ"],
    ["Lao with a zero-width space in the text", "ແມ່ນ\u200bຫຍັງ"],
    ["Khmer", "តើអ្វីដែល"],
    ["Myanmar", "ဘာလဲ"],
  ])("%s matches", (_name, text) => expect(matches(text)).toBe(true));

  test("kana words match anywhere when the list holds them", () => {
    const kana = createWhatMatcher(["なに", "ナニ"]);
    expect(kana("これはなにですか")).toBe(true);
    expect(kana("ナニ?")).toBe(true);
    expect(kana("これは")).toBe(false);
  });
});

describe("hostile input", () => {
  test("a 4000-character run of repeated letters is cheap and does not match", () => {
    const hostile = `xc${"h".repeat(5)}${"i".repeat(3993)}`;
    const started = performance.now();
    for (let i = 0; i < 20; i++) matches(hostile);
    const perMessage = (performance.now() - started) / 20;
    expect(matches(hostile)).toBe(false);
    // A backtracking regex takes seconds here; the bound is loose so a busy CI runner with coverage passes.
    expect(perMessage).toBeLessThan(50);
  });

  test("only the first 2000 characters are searched", () => {
    expect(matches(`${"x ".repeat(1000)}what`)).toBe(false);
    expect(matches(`what ${"x ".repeat(1000)}`)).toBe(true);
  });

  test("stretched words still match after repeats are collapsed", () => {
    expect(matches("whaaaaat")).toBe(true);
    expect(matches("COOOOO")).toBe(true);
  });
});

describe("matcher construction", () => {
  test("an empty list never matches", () => {
    expect(createWhatMatcher([])("what")).toBe(false);
  });

  test("regex metacharacters in words are taken literally", () => {
    const literal = createWhatMatcher(["a.b", "c+d"]);
    expect(literal("a.b")).toBe(true);
    expect(literal("axb")).toBe(false);
    expect(literal("c+d")).toBe(true);
  });
});
