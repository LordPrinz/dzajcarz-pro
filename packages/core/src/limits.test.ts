import { describe, expect, test } from "bun:test";
import { DISCORD_LIMITS, replyLimitProblems, validateReplyLimits } from "./limits.ts";

describe("Discord reply limits", () => {
  test("a reply at every limit passes", () => {
    expect(
      replyLimitProblems({
        content: "a".repeat(DISCORD_LIMITS.content),
        embeds: [
          { title: "t".repeat(256), description: "d".repeat(4096), footer: "f".repeat(100) },
        ],
      }),
    ).toEqual([]);
  });

  test("content over 2000 characters is named", () => {
    expect(() => validateReplyLimits("a".repeat(2001))).toThrow(
      "content has 2001 characters, Discord allows 2000",
    );
  });

  test("emoji count as one character each", () => {
    expect(replyLimitProblems("😀".repeat(2000))).toEqual([]);
    expect(replyLimitProblems("😀".repeat(2001))).toHaveLength(1);
  });

  test("each embed part has its own limit", () => {
    const problems = replyLimitProblems({
      embeds: [
        {
          title: "t".repeat(257),
          description: "d".repeat(4097),
          fields: [{ name: "n".repeat(257), value: "v".repeat(1025) }],
          author: { name: "a".repeat(257) },
        },
      ],
    });
    expect(problems).toEqual([
      "embed 0 title has 257 characters, Discord allows 256",
      "embed 0 description has 4097 characters, Discord allows 4096",
      "embed 0 author has 257 characters, Discord allows 256",
      "embed 0 field 0 name has 257 characters, Discord allows 256",
      "embed 0 field 0 value has 1025 characters, Discord allows 1024",
    ]);
  });

  test("too many embeds or fields, and too much text across embeds", () => {
    const fields = Array.from({ length: 26 }, () => ({ name: "n", value: "v" }));
    expect(replyLimitProblems({ embeds: [{ fields }] })).toEqual([
      "embed 0 has 26 fields, Discord allows 25",
    ]);
    expect(replyLimitProblems({ embeds: Array.from({ length: 11 }, () => ({})) })).toEqual([
      "11 embeds, Discord allows 10",
    ]);
    const big = { description: "d".repeat(4000) };
    expect(replyLimitProblems({ embeds: [big, big] })).toEqual([
      "embeds have 8000 characters together, Discord allows 6000",
    ]);
  });
});
