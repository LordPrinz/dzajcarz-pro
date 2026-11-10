import { describe, expect, test } from "bun:test";
import { credentialsIntact, Env, loadEnv } from "./env.ts";

const REQUIRED = {
  DISCORD_TOKEN: "t".repeat(60),
  DISCORD_CLIENT_ID: "123456789012345678",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe.each(["RIOT_VALORANT_API_KEY", "RIOT_LOL_API_KEY"] as const)("%s", (name) => {
  test("is off when unset", () => {
    expect(loadEnv(REQUIRED)[name]).toBeUndefined();
  });

  test("is off when empty, as in a fresh copy of .env.example", () => {
    expect(loadEnv({ ...REQUIRED, [name]: "" })[name]).toBeUndefined();
  });

  test("is kept when set, without enabling the other game", () => {
    const env = loadEnv({ ...REQUIRED, [name]: "RGAPI-test" });
    expect(env[name]).toBe("RGAPI-test");
    expect(
      Object.values({ v: env.RIOT_VALORANT_API_KEY, l: env.RIOT_LOL_API_KEY }).filter(Boolean),
    ).toEqual(["RGAPI-test"]);
  });
});

describe("health endpoint", () => {
  test("listens on 127.0.0.1:8080 by default", () => {
    const env = loadEnv(REQUIRED);
    expect([env.HEALTH_HOSTNAME, env.HEALTH_PORT]).toEqual(["127.0.0.1", 8080]);
  });

  test("takes a port and hostname from the environment", () => {
    const env = loadEnv({ ...REQUIRED, HEALTH_PORT: "9000", HEALTH_HOSTNAME: "0.0.0.0" });
    expect([env.HEALTH_HOSTNAME, env.HEALTH_PORT]).toEqual(["0.0.0.0", 9000]);
  });

  test("port 0 disables the endpoint", () => {
    expect(loadEnv({ ...REQUIRED, HEALTH_PORT: "0" }).HEALTH_PORT).toBe(0);
  });
});

describe("connection URLs", () => {
  const issues = (overrides: Record<string, string>) => {
    const parsed = Env.safeParse({ ...REQUIRED, ...overrides });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };
  const BROKEN = /URL-safe password such as `openssl rand -hex 32`/;

  test("accept a hex password and a URL without credentials", () => {
    expect(
      issues({
        DATABASE_URL: "postgres://dzajcarz:0a1b2c3d@postgres:5432/dzajcarz",
        REDIS_URL: "redis://:9f8e7d@redis:6379/0",
      }),
    ).toEqual([]);
    expect(issues({ REDIS_URL: "redis://localhost:6379" })).toEqual([]);
  });

  test("accept a percent-encoded password", () => {
    expect(issues({ DATABASE_URL: "postgres://u:p%40ss%2Fw%23rd@db:5432/db" })).toEqual([]);
  });

  test.each(["p@ss", "p/ss", "p?ss", "p#ss"])(
    "reject an unencoded %s in the password",
    (password) => {
      const messages = issues({ DATABASE_URL: `postgres://u:${password}@db:5432/db` });
      expect(messages.some((message) => BROKEN.test(message))).toBe(true);
    },
  );

  test("reject an empty password, e.g. from an unset variable", () => {
    const messages = issues({ REDIS_URL: "redis://:@redis:6379/0" });
    expect(messages.some((message) => BROKEN.test(message))).toBe(true);
  });

  test("still check the scheme", () => {
    expect(issues({ DATABASE_URL: "mysql://u:p@db/db" })).not.toEqual([]);
  });
});

describe("credentialsIntact", () => {
  test("ignores URLs without credentials", () => {
    expect(credentialsIntact("redis://redis:6379/0")).toBe(true);
  });

  test("is false when a slash in the password cuts the host part short", () => {
    expect(credentialsIntact("postgres://u:12/x@db/db")).toBe(false);
  });
});
