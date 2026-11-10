import { describe, expect, test } from "bun:test";
import { RESTJSONErrorCodes } from "discord.js";
import { hasCode } from "./errors.ts";

describe("hasCode", () => {
  test("matches any of the given codes of an API error", () => {
    const error = Object.assign(new Error("Unknown Channel"), {
      code: RESTJSONErrorCodes.UnknownChannel,
    });
    expect(hasCode(error, RESTJSONErrorCodes.UnknownChannel)).toBe(true);
    expect(
      hasCode(error, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownChannel),
    ).toBe(true);
    expect(hasCode(error, RESTJSONErrorCodes.UnknownMember)).toBe(false);
  });

  test("is false for anything that is not an API error", () => {
    expect(hasCode(new Error("x"), 10003)).toBe(false);
    expect(hasCode(null, 10003)).toBe(false);
    expect(hasCode({ code: "ECONNRESET" }, 10003)).toBe(false);
  });
});
