import { describe, expect, test } from "bun:test";
import { UserError } from "@dzajcarz/core";
import { t } from "./messages.ts";
import { parseRiotId } from "./riot-id.ts";

describe("parseRiotId", () => {
  test("splits name and tag", () => {
    expect(parseRiotId("Dzajcarz#EUNE")).toEqual({ gameName: "Dzajcarz", tagLine: "EUNE" });
  });

  test("trims around the whole id and around the parts", () => {
    expect(parseRiotId("  Nazwa  # TAG1 ")).toEqual({ gameName: "Nazwa", tagLine: "TAG1" });
  });

  test("keeps spaces and non-Latin letters in the name", () => {
    expect(parseRiotId("Zażółć gęślą#EUNE")).toEqual({
      gameName: "Zażółć gęślą",
      tagLine: "EUNE",
    });
    expect(parseRiotId("日本語の名前#JP1")).toEqual({ gameName: "日本語の名前", tagLine: "JP1" });
  });

  test("accepts a lowercase tag", () => {
    expect(parseRiotId("Nazwa#eune").tagLine).toBe("eune");
  });

  test.each([
    ["no hash", "Nazwa"],
    ["empty", ""],
    ["empty name", "#TAG"],
    ["empty tag", "Nazwa#"],
    ["name too short", "ab#TAG"],
    ["name too long", `${"a".repeat(17)}#TAG`],
    ["tag too short", "Nazwa#AB"],
    ["tag too long", "Nazwa#ABCDEF"],
    ["tag with a symbol", "Nazwa#TA-G"],
    ["doubled hash", "Nazwa##TAG"],
    ["hash inside the name", "Na#zwa#TAG"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseRiotId(input)).toThrow(new UserError(t("pl").riotIdHelp));
  });
});
