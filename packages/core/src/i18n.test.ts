import { expect, test } from "bun:test";
import { allLocalizations, defineMessages, fromDiscordLocale, isLocale, localize } from "./i18n.ts";

const t = defineMessages({
  pl: { hello: "Cześć", queued: (title: string, count: number) => `Dodano ${title} (${count}).` },
  en: { hello: "Hi", queued: (title, count) => `Queued ${title} (${count}).` },
  de: { hello: "Hallo", queued: (title, count) => `${title} hinzugefügt (${count}).` },
});

test("a catalog answers in the asked language", () => {
  expect(t("pl").hello).toBe("Cześć");
  expect(t("en").queued("Song", 2)).toBe("Queued Song (2).");
  expect(t("de").queued("Lied", 1)).toBe("Lied hinzugefügt (1).");
});

test("a language that misses a key, adds one or changes arguments does not typecheck", () => {
  defineMessages({
    pl: { hello: "Cześć" },
    // @ts-expect-error: `hello` is missing
    en: {},
    de: { hello: "Hallo" },
  });
  defineMessages({
    pl: { hello: "Cześć" },
    // @ts-expect-error: `bye` is not in the Polish catalog
    en: { hello: "Hi", bye: "Bye" },
    de: { hello: "Hallo" },
  });
  defineMessages({
    pl: { count: (n: number) => `${n}` },
    // @ts-expect-error: the argument must stay a number
    en: { count: (n: string) => n },
    de: { count: (n) => `${n}` },
  });
});

test("Discord client locales map onto ours", () => {
  expect(fromDiscordLocale("pl")).toBe("pl");
  expect(fromDiscordLocale("en-US")).toBe("en");
  expect(fromDiscordLocale("en-GB")).toBe("en");
  expect(fromDiscordLocale("de")).toBe("de");
  expect(fromDiscordLocale("fr")).toBeNull();
  expect(fromDiscordLocale(undefined)).toBeNull();
});

test("localized text", () => {
  const text = { pl: "kolejka", en: "queue", de: "Warteschlange" };
  expect(localize(text, "de")).toBe("Warteschlange");
  expect(localize("8d", "en")).toBe("8d");
  expect(allLocalizations(text)).toEqual(["kolejka", "queue", "Warteschlange"]);
  expect(isLocale("en")).toBe(true);
  expect(isLocale("fr")).toBe(false);
});

test("all() gives a plain entry in every language, for command metadata", () => {
  expect(t.all("hello")).toEqual({ pl: "Cześć", en: "Hi", de: "Hallo" });
  // @ts-expect-error: `queued` takes arguments, so it has no single text per language
  t.all("queued");
});
