import { describe, expect, test } from "bun:test";
import {
  escapeMarkdown,
  formatDuration,
  httpUrl,
  MAX_SEARCH_LENGTH,
  MAX_URL_LENGTH,
  parseQuery,
  parseTime,
  progressLine,
  truncate,
} from "./format.ts";
import { tracksWord } from "./panel.ts";

describe("parseQuery", () => {
  test("keeps links to supported sites as links, in normalised form", () => {
    expect(parseQuery(" https://youtu.be/x ")).toEqual({ kind: "url", url: "https://youtu.be/x" });
    for (const [input, url] of [
      ["HTTPS://WWW.YOUTUBE.COM/watch?v=x", "https://www.youtube.com/watch?v=x"],
      ["https://m.youtube.com/watch?v=x", "https://m.youtube.com/watch?v=x"],
      ["https://music.youtube.com/watch?v=x", "https://music.youtube.com/watch?v=x"],
      ["http://youtube.com:80/watch?v=x", "http://youtube.com/watch?v=x"],
      ["https://soundcloud.com/a/b", "https://soundcloud.com/a/b"],
      ["https://m.soundcloud.com/a/b", "https://m.soundcloud.com/a/b"],
      ["https://on.soundcloud.com/abc", "https://on.soundcloud.com/abc"],
      ["https://bandcamp.com/discover", "https://bandcamp.com/discover"],
      ["https://artist.bandcamp.com/album/a", "https://artist.bandcamp.com/album/a"],
      ["https://www.twitch.tv/someone", "https://www.twitch.tv/someone"],
      ["https://m.twitch.tv/someone", "https://m.twitch.tv/someone"],
      ["https://twitch.tv/someone", "https://twitch.tv/someone"],
      ["https://vimeo.com/1", "https://vimeo.com/1"],
      ["https://www.vimeo.com/1", "https://www.vimeo.com/1"],
      ["https://player.vimeo.com/video/1", "https://player.vimeo.com/video/1"],
      // Full-width letters map to ASCII in the parser; the node gets the checked host.
      ["https://ｙｏｕｔｕｂｅ.com/watch?v=x", "https://youtube.com/watch?v=x"],
    ]) {
      expect(parseQuery(input as string)).toEqual({ kind: "url", url: url as string });
    }
  });

  test("refuses links to any other host", () => {
    for (const text of [
      "https://example.com/a.mp3",
      "http://127.0.0.1:2333/x",
      "https://youtube.com.evil.com/x",
      "https://evilyoutube.com/x",
      "https://notbandcamp.com/x",
      "https://youtube.com./x",
      "https://user@youtube.com/x",
      "https://user:pass@youtube.com/x",
      "https://youtube.com:8443/x",
      "https://xn--youtube-5ya.com/x",
      "https://yοutube.com/x",
      "https://gaming.youtube.com/x",
      "https://www.soundcloud.com/x",
      "https://",
    ]) {
      expect(parseQuery(text)).toEqual({ kind: "unsupported" });
    }
  });

  test("everything that is not an http(s) link is search text", () => {
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

  test("URLs go out in the parser's form and only up to Discord's length", () => {
    expect(httpUrl("HTTPS://I.YTIMG.COM/a b.jpg")).toBe("https://i.ytimg.com/a%20b.jpg");
    const long = `https://i.ytimg.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(httpUrl(long)).toBeUndefined();
    const fits = `https://i.ytimg.com/${"a".repeat(MAX_URL_LENGTH - 20)}`;
    expect(httpUrl(fits)).toBe(fits);
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

describe("parseTime", () => {
  test("reads seconds, clock times and unit times", () => {
    expect(parseTime("90")).toBe(90_000);
    expect(parseTime("0")).toBe(0);
    expect(parseTime("1:30")).toBe(90_000);
    expect(parseTime("0:05")).toBe(5000);
    expect(parseTime("90:00")).toBe(5_400_000);
    expect(parseTime("1:02:03")).toBe(3_723_000);
    expect(parseTime("1m30s")).toBe(90_000);
    expect(parseTime("1m30")).toBe(90_000);
    expect(parseTime("1m")).toBe(60_000);
    expect(parseTime("45s")).toBe(45_000);
    expect(parseTime("90s")).toBe(90_000);
    expect(parseTime("90m")).toBe(5_400_000);
    expect(parseTime("1h2m3s")).toBe(3_723_000);
    expect(parseTime("1h2m3")).toBe(3_723_000);
    expect(parseTime("2h")).toBe(7_200_000);
  });

  test("ignores case and spaces", () => {
    expect(parseTime("  1M 30S ")).toBe(90_000);
    expect(parseTime("1 m 30 s")).toBe(90_000);
    expect(parseTime("1 h 2 m 3 s")).toBe(3_723_000);
    expect(parseTime(" 1:30 ")).toBe(90_000);
  });

  test("a part after a larger one stays under 60 in both forms", () => {
    expect(parseTime("1:59")).toBe(119_000);
    expect(parseTime("1m59s")).toBe(119_000);
    expect(parseTime("1h59m")).toBe(7_140_000);
    for (const bad of [
      "1:60",
      "1:75",
      "1:99:00",
      "1m60s",
      "1m90s",
      "1m90",
      "1h60m",
      "1h75m",
      "1h90s",
    ]) {
      expect(parseTime(bad)).toBeNull();
    }
  });

  test("minutes go up to 99 without hours", () => {
    expect(parseTime("99:59")).toBe(5_999_000);
    expect(parseTime("99m")).toBe(5_940_000);
    expect(parseTime("100:00")).toBeNull();
    expect(parseTime("100m")).toBeNull();
    expect(parseTime("1:40:00")).toBe(6_000_000);
  });

  test("refuses everything else", () => {
    for (const bad of [
      "",
      "   ",
      "abc",
      "-5",
      "1.5",
      "1:5",
      "1:2:3:4",
      "30s1m",
      "1m 1m",
      "m",
      "s",
      "1h30",
      "30ms",
      "99999999",
      "999h",
      "1e3",
    ]) {
      expect(parseTime(bad)).toBeNull();
    }
  });

  test("stops at 99:59:59", () => {
    expect(parseTime("359999")).toBe(359_999_000);
    expect(parseTime("99:59:59")).toBe(359_999_000);
    expect(parseTime("99h59m59s")).toBe(359_999_000);
    expect(parseTime("360000")).toBeNull();
  });
});
