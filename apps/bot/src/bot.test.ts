import { describe, expect, test } from "bun:test";
import { matchInvocation } from "./bot.ts";

const BOT = "111111111111111111";

describe("matchInvocation", () => {
  test("accepts the guild prefix", () => {
    expect(matchInvocation("?ping", "?", BOT)).toEqual({ name: "ping", rest: "" });
    expect(matchInvocation("!ping", "?", BOT)).toBeNull();
  });

  test("accepts a mention of the bot instead of the prefix", () => {
    expect(matchInvocation(`<@${BOT}> play abc`, "!", BOT)).toEqual({ name: "play", rest: "abc" });
    expect(matchInvocation(`<@!${BOT}>help`, "!", BOT)).toEqual({ name: "help", rest: "" });
    expect(matchInvocation("<@222222222222222222> ping", "!", BOT)).toBeNull();
    expect(matchInvocation(`<@${BOT}>`, "!", BOT)).toBeNull();
    // Still works after a guild switches to a prefix of its own.
    expect(matchInvocation(`<@${BOT}> prefix reset`, "dz", BOT)).toEqual({
      name: "prefix",
      rest: "reset",
    });
  });
});
