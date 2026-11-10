import { describe, expect, test } from "bun:test";
import { codeBlocks, fitLines, plural, requireGuild, UserError } from "./index.ts";

describe("requireGuild", () => {
  test("passes a guild id through and refuses a DM with the given text", () => {
    expect(requireGuild("1")).toBe("1");
    expect(() => requireGuild(null)).toThrow(new UserError("Ta komenda działa tylko na serwerze."));
    expect(() => requireGuild(null, "Muzyka działa tylko na serwerze.")).toThrow(
      "Muzyka działa tylko na serwerze.",
    );
  });
});

describe("plural", () => {
  test.each([
    [1, "komenda"],
    [2, "komendy"],
    [4, "komendy"],
    [5, "komend"],
    [12, "komend"],
    [14, "komend"],
    [22, "komendy"],
    [0, "komend"],
  ])("%i %s", (count, word) => {
    expect(plural(count, "komenda", "komendy", "komend")).toBe(word);
  });
});

describe("codeBlocks", () => {
  test("wraps the text and breaks backtick runs", () => {
    expect(codeBlocks("a```b")).toEqual(["```\na`\u200b`\u200b`\u200bb\n```"]);
  });

  test("splits long text into blocks that fit a message", () => {
    const blocks = codeBlocks("x".repeat(4000));
    expect(blocks).toHaveLength(3);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(2000);
  });
});

describe("fitLines", () => {
  test("keeps everything that fits and counts the rest", () => {
    expect(fitLines(["a", "b"], 100)).toBe("a\nb");
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(20, "."));
    const cut = fitLines(lines, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("… i jeszcze 7")).toBe(true);
  });
});
