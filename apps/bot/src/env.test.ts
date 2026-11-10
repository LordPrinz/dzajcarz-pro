import { describe, expect, test } from "bun:test";
import { credentialsIntact, Env, loadDeployEnv, loadEnv } from "./env.ts";

const REQUIRED = {
  DISCORD_TOKEN: "t".repeat(60),
  DISCORD_CLIENT_ID: "123456789012345678",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe.each([
  ["RIOT_VALORANT_API_KEY", "RIOT_LOL_API_KEY"],
  ["RIOT_LOL_API_KEY", "RIOT_VALORANT_API_KEY"],
] as const)("%s", (name, other) => {
  test("is off when unset", () => {
    expect(loadEnv(REQUIRED)[name]).toBeUndefined();
  });

  test("is off when empty, as in a fresh copy of .env.example", () => {
    expect(loadEnv({ ...REQUIRED, [name]: "" })[name]).toBeUndefined();
  });

  test("is kept when set, without enabling the other game", () => {
    const env = loadEnv({ ...REQUIRED, [name]: "RGAPI-test" });
    expect(env[name]).toBe("RGAPI-test");
    expect(env[other]).toBeUndefined();
  });
});

describe("Discord application", () => {
  const { DISCORD_TOKEN: _token, DISCORD_CLIENT_ID: _clientId, ...DATA } = REQUIRED;
  const PROD = { DISCORD_TOKEN: "p".repeat(60), DISCORD_CLIENT_ID: "111111111111111111" };
  const DEV = { DISCORD_DEV_TOKEN: "d".repeat(60), DISCORD_DEV_CLIENT_ID: "222222222222222222" };
  const credentials = (env: { DISCORD_TOKEN: string; DISCORD_CLIENT_ID: string }) => [
    env.DISCORD_TOKEN,
    env.DISCORD_CLIENT_ID,
  ];

  test("runs as the production bot when only that pair is set", () => {
    const env = loadEnv({ ...DATA, ...PROD });
    expect(env.DISCORD_APP).toBe("prod");
    expect(credentials(env)).toEqual([PROD.DISCORD_TOKEN, PROD.DISCORD_CLIENT_ID]);
  });

  test("runs as the test bot when only that pair is set", () => {
    const env = loadEnv({ ...DATA, ...DEV });
    expect(env.DISCORD_APP).toBe("dev");
    expect(credentials(env)).toEqual([DEV.DISCORD_DEV_TOKEN, DEV.DISCORD_DEV_CLIENT_ID]);
  });

  test("prefers the test bot when both pairs are set", () => {
    const env = loadEnv({ ...DATA, ...PROD, ...DEV });
    expect(env.DISCORD_APP).toBe("dev");
    expect(credentials(env)).toEqual([DEV.DISCORD_DEV_TOKEN, DEV.DISCORD_DEV_CLIENT_ID]);
  });

  test("treats empty test values as unset, as in a fresh copy of .env.example", () => {
    const env = loadEnv({ ...DATA, ...PROD, DISCORD_DEV_TOKEN: "", DISCORD_DEV_CLIENT_ID: "" });
    expect(env.DISCORD_APP).toBe("prod");
  });

  test("needs one complete pair", () => {
    expect(Env.safeParse({ ...DATA }).success).toBe(false);
    expect(Env.safeParse({ ...DATA, DISCORD_TOKEN: PROD.DISCORD_TOKEN }).success).toBe(false);
  });

  test("refuses half of the test pair, so a stray token cannot fall back to production", () => {
    for (const half of [
      { DISCORD_DEV_TOKEN: DEV.DISCORD_DEV_TOKEN },
      { DISCORD_DEV_CLIENT_ID: DEV.DISCORD_DEV_CLIENT_ID },
    ]) {
      const parsed = Env.safeParse({ ...DATA, ...PROD, ...half });
      expect(parsed.success).toBe(false);
    }
  });

  test("the slash command deploy makes the same choice", () => {
    const deploy = loadDeployEnv({ ...PROD, ...DEV });
    expect(credentials(deploy)).toEqual([DEV.DISCORD_DEV_TOKEN, DEV.DISCORD_DEV_CLIENT_ID]);
    expect(loadDeployEnv({ ...PROD }).DISCORD_APP).toBe("prod");
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

describe("BOT_PREFIX", () => {
  test("defaults to ! and keeps a valid prefix", () => {
    expect(loadEnv(REQUIRED).BOT_PREFIX).toBe("!");
    expect(loadEnv({ ...REQUIRED, BOT_PREFIX: "dz" }).BOT_PREFIX).toBe("dz");
  });

  test.each(["a b", "`", "", "abcdef", "\u200b"])("refuses %p like /prefix does", (prefix) => {
    expect(Env.safeParse({ ...REQUIRED, BOT_PREFIX: prefix }).success).toBe(false);
  });
});
