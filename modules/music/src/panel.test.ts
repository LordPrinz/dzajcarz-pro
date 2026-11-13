import { describe, expect, test } from "bun:test";
import { track } from "./fakes.test-support.ts";
import { queueLines, trackEmbed } from "./panel.ts";

const withLink = (title: string, length: number) => ({
  ...track(title),
  uri: `https://example.com/${"a".repeat(length - "https://example.com/".length)}`,
});

describe("a track without a requester", () => {
  const anonymous = { ...track("Song"), requesterId: "" };

  test("the panel and the queue leave the mention out", () => {
    expect(trackEmbed(anonymous, 0, 0, "", "pl").description).not.toContain("<@");
    expect(queueLines(1, [anonymous], "pl")[0]).not.toContain("<@");
  });
});

describe("queueLines", () => {
  test("keeps the link of a normal track", () => {
    const [line] = queueLines(3, [track("Song")], "pl");
    expect(line).toStartWith("`3.` [Song](https://www.youtube.com/watch?v=Song)");
  });

  test("drops a link longer than 300 characters but keeps the escaped title", () => {
    const [line] = queueLines(1, [withLink("Long_one", 301)], "pl");
    expect(line).toStartWith("`1.` Long\\_one · ");
    expect(line).not.toContain("https://");
  });

  test("ten tracks with 2000-character links still fit the embed description", () => {
    const tracks = Array.from({ length: 10 }, (_, i) => withLink(`Song ${i}`, 2000));
    const lines = queueLines(1, tracks, "pl");
    expect(lines).toHaveLength(10);
    // The "now playing" head takes at most about 200 characters of the 4096.
    expect(lines.join("\n").length + 200).toBeLessThanOrEqual(4096);
  });

  test("links that are each short but together too long are dropped from the end", () => {
    const tracks = Array.from({ length: 10 }, () => withLink("_".repeat(60), 300));
    const lines = queueLines(1, tracks, "pl");
    expect(lines.join("\n").length).toBeLessThanOrEqual(3700);
    expect(lines[0]).toContain("https://");
    expect(lines[9]).not.toContain("https://");
  });
});
