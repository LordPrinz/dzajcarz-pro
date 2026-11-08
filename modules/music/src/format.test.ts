import { describe, expect, test } from "bun:test";
import {
  escapeMarkdown,
  formatDuration,
  httpUrl,
  MAX_SEARCH_LENGTH,
  parseQuery,
  progressLine,
  truncate,
} from "./format.ts";
import { tracksWord } from "./panel.ts";

describe("parseQuery", () => {
  test("keeps only http(s) links as links", () => {
    expect(parseQuery(" https://youtu.be/x ")).toEqual({ kind: "url", url: "https://youtu.be/x" });
    expect(parseQuery("HTTP://example.com/a.mp3")).toEqual({
      kind: "url",
      url: "HTTP://example.com/a.mp3",
    });
    for (const text of ["ftp://x/y", "local:song.mp3", "/opt/music/a.mp3", "scsearch:daft punk"]) {
      expect(parseQuery(text)).toEqual({ kind: "search", text });
    }
  });

  test("treats a link followed by words as a search", () => {
    expect(parseQuery("https://youtu.be/x and more")?.kind).toBe("search");
  });

  test("unwraps <link> and drops empty input", () => {
    expect(parseQuery("<https://youtu.be/x>")).toEqual({ kind: "url", url: "https://youtu.be/x" });
    expect(parseQuery("  ")).toBeNull();
    expect(parseQuery("<>")).toBeNull();
  });

  test("cuts very long search text", () => {
    const query = parseQuery("ą".repeat(500));
    expect(query?.kind === "search" && [...query.text].length).toBe(MAX_SEARCH_LENGTH);
  });
});

describe("formatting", () => {
  test("durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(187_000)).toBe("3:07");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });

  test("progress line", () => {
    expect(progressLine(0, 100_000, false)).toStartWith("🔘▬");
    expect(progressLine(100_000, 100_000, false)).toEndWith("▬🔘 1:40 / 1:40");
    expect(progressLine(500_000, 100_000, false)).toEndWith("1:40 / 1:40");
    expect(progressLine(65_000, 0, true)).toBe("🔴 Na żywo · 1:05");
  });

  test("markdown in titles is escaped", () => {
    expect(escapeMarkdown("**a_b** [x](y) `c`")).toBe("\\*\\*a\\_b\\*\\* \\[x\\]\\(y\\) \\`c\\`");
  });

  test("truncate counts code points", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("🎵🎵🎵🎵", 3)).toBe("🎵🎵…");
  });

  test("only http(s) URLs pass", () => {
    expect(httpUrl("https://i.ytimg.com/a.jpg")).toBe("https://i.ytimg.com/a.jpg");
    expect(httpUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpUrl(null)).toBeUndefined();
  });

  test("Polish plural of utwór", () => {
    expect([1, 2, 4, 5, 12, 14, 21, 22, 25, 112, 122].map(tracksWord)).toEqual([
      "utwór",
      "utwory",
      "utwory",
      "utworów",
      "utworów",
      "utworów",
      "utworów",
      "utwory",
      "utworów",
      "utworów",
      "utwory",
    ]);
  });
});
