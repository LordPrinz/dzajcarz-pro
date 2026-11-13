import { describe, expect, test } from "bun:test";
import { RESTJSONErrorCodes } from "discord.js";
import { fetchOrNull, hasCode } from "./errors.ts";

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

describe("fetchOrNull", () => {
  const api = (code: number) => Object.assign(new Error("api"), { code });

  test("passes the value through", async () => {
    expect(await fetchOrNull(Promise.resolve(1))).toBe(1);
  });

  test("is null for gone or forbidden targets", async () => {
    expect(await fetchOrNull(Promise.reject(api(RESTJSONErrorCodes.UnknownChannel)))).toBeNull();
    expect(await fetchOrNull(Promise.reject(api(RESTJSONErrorCodes.MissingAccess)))).toBeNull();
  });

  test("rethrows anything else", async () => {
    const outage = new Error("503");
    await expect(fetchOrNull(Promise.reject(outage))).rejects.toBe(outage);
  });
});
