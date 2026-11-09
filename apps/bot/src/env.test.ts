import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env.ts";

const REQUIRED = {
  DISCORD_TOKEN: "t".repeat(60),
  DISCORD_CLIENT_ID: "123456789012345678",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("RIOT_API_KEY", () => {
  test("is off when unset", () => {
    expect(loadEnv(REQUIRED).RIOT_API_KEY).toBeUndefined();
  });

  test("is off when empty, as in a fresh copy of .env.example", () => {
    expect(loadEnv({ ...REQUIRED, RIOT_API_KEY: "" }).RIOT_API_KEY).toBeUndefined();
  });

  test("is kept when set", () => {
    expect(loadEnv({ ...REQUIRED, RIOT_API_KEY: "RGAPI-test" }).RIOT_API_KEY).toBe("RGAPI-test");
  });
});
