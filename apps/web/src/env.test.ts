import { describe, expect, test } from "bun:test";
import { Env } from "./env.ts";

const REQUIRED = {
  WEB_PUBLIC_ORIGIN: "https://panel.example.com",
  WEB_DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  WEB_REDIS_URL: "redis://localhost:6379",
};

describe("Env", () => {
  test("applies the defaults", () => {
    const env = Env.parse(REQUIRED);
    expect(env).toMatchObject({
      WEB_PORT: 3000,
      WEB_HOSTNAME: "127.0.0.1",
      LOG_LEVEL: "info",
      BOT_REQUEST_TIMEOUT_MS: 3000,
    });
  });

  test("empty values count as unset, as in a fresh copy of .env.example", () => {
    const env = Env.parse({
      ...REQUIRED,
      WEB_PORT: "",
      WEB_HOSTNAME: "",
      BOT_REQUEST_TIMEOUT_MS: "",
    });
    expect(env.WEB_PORT).toBe(3000);
    expect(env.WEB_HOSTNAME).toBe("127.0.0.1");
  });

  test("WEB_PUBLIC_ORIGIN is required", () => {
    const { WEB_PUBLIC_ORIGIN: _, ...rest } = REQUIRED;
    const parsed = Env.safeParse(rest);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["WEB_PUBLIC_ORIGIN"]);
  });

  test.each([
    "https://panel.example.com/",
    "https://panel.example.com/panel",
    "https://panel.example.com?x=1",
    "https://panel.example.com#top",
    "ftp://panel.example.com",
    "panel.example.com",
  ])("WEB_PUBLIC_ORIGIN %p is not a bare origin", (value) => {
    expect(Env.safeParse({ ...REQUIRED, WEB_PUBLIC_ORIGIN: value }).success).toBe(false);
  });

  test.each(["http://localhost:3000", "https://panel.example.com:8443"])(
    "WEB_PUBLIC_ORIGIN %p is accepted",
    (value) => {
      expect(Env.parse({ ...REQUIRED, WEB_PUBLIC_ORIGIN: value }).WEB_PUBLIC_ORIGIN).toBe(value);
    },
  );

  test("a password that breaks the URL is refused", () => {
    expect(
      Env.safeParse({ ...REQUIRED, WEB_DATABASE_URL: "postgres://u:12/x@db/db" }).success,
    ).toBe(false);
    expect(Env.safeParse({ ...REQUIRED, WEB_REDIS_URL: "redis://:@redis:6379" }).success).toBe(
      false,
    );
  });

  test.each([
    ["redis://web:pw@redis:6379", true],
    ["redis://web:pw@redis:6379/", true],
    ["redis://web:pw@redis:6379/0", true],
    ["redis://web:pw@redis:6379/1", false],
  ])("WEB_REDIS_URL %s is accepted: %p", (url, accepted) => {
    expect(Env.safeParse({ ...REQUIRED, WEB_REDIS_URL: url }).success).toBe(accepted);
  });

  test("the URLs must use their own scheme", () => {
    expect(Env.safeParse({ ...REQUIRED, WEB_DATABASE_URL: "redis://localhost" }).success).toBe(
      false,
    );
    expect(Env.safeParse({ ...REQUIRED, WEB_REDIS_URL: "postgres://localhost" }).success).toBe(
      false,
    );
  });

  test.each([
    ["499", false],
    ["500", true],
    ["30000", true],
    ["30001", false],
    ["abc", false],
    ["1500.5", false],
  ])("BOT_REQUEST_TIMEOUT_MS %p is valid: %p", (value, valid) => {
    expect(Env.safeParse({ ...REQUIRED, BOT_REQUEST_TIMEOUT_MS: value }).success).toBe(valid);
  });

  test.each([
    ["0", false],
    ["1", true],
    ["65535", true],
    ["65536", false],
  ])("WEB_PORT %p is valid: %p", (value, valid) => {
    expect(Env.safeParse({ ...REQUIRED, WEB_PORT: value }).success).toBe(valid);
  });
});
