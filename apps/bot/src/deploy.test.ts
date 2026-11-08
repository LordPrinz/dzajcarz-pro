import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { ApplicationIntegrationType, InteractionContextType } from "discord.js";
import {
  buildDeployBody,
  createDeployRegistry,
  type DeployStep,
  deployOnStartup,
  deployRoute,
  deployTarget,
  sameCommands,
  unusedServices,
} from "./deploy.ts";
import { loadDeployEnv, loadEnv } from "./env.ts";

const GUILD = "100000000000000001";
const CLIENT = "200000000000000002";
const base = { DISCORD_TOKEN: "x".repeat(60), DISCORD_CLIENT_ID: CLIENT };
const target = (extra: Record<string, string>) =>
  deployTarget(loadDeployEnv({ ...base, ...extra }));

describe("deployTarget", () => {
  test("a dev guild gets the commands, without one they go global", () => {
    expect(target({ DISCORD_DEV_GUILD_ID: GUILD })).toEqual([
      { scope: "guild", guildId: GUILD, clear: false },
    ]);
    expect(target({})).toEqual([{ scope: "global", clear: false }]);
  });

  test("DEPLOY_GLOBAL sets the global commands and empties the dev guild", () => {
    expect(target({ DISCORD_DEV_GUILD_ID: GUILD, DEPLOY_GLOBAL: "1" })).toEqual([
      { scope: "global", clear: false },
      { scope: "guild", guildId: GUILD, clear: true },
    ]);
    expect(target({ DEPLOY_GLOBAL: "true" })).toEqual([{ scope: "global", clear: false }]);
  });

  test("DEPLOY_CLEAR empties the global set only", () => {
    expect(target({ DISCORD_DEV_GUILD_ID: GUILD, DEPLOY_CLEAR: "1" })).toEqual([
      { scope: "global", clear: true },
    ]);
  });

  test("flags accept 1/true, treat empty as off", () => {
    expect(target({ DISCORD_DEV_GUILD_ID: GUILD, DEPLOY_GLOBAL: "" })).toEqual([
      { scope: "guild", guildId: GUILD, clear: false },
    ]);
  });

  test("routes point at the application or at the guild", () => {
    expect(deployRoute(CLIENT, { scope: "global", clear: false })).toBe(
      `/applications/${CLIENT}/commands`,
    );
    expect(deployRoute(CLIENT, { scope: "guild", guildId: GUILD, clear: true })).toBe(
      `/applications/${CLIENT}/guilds/${GUILD}/commands`,
    );
  });
});

describe("buildDeployBody", () => {
  const global = buildDeployBody({ scope: "global", clear: false });
  const byName = (name: string) => {
    const found = global.find((c) => c.name === name);
    if (!found) throw new Error(`command ${name} missing`);
    return found;
  };

  test("a clear step sends an empty set", () => {
    expect(buildDeployBody({ scope: "global", clear: true })).toEqual([]);
  });

  test("a guild deploy carries no contexts or integration types", () => {
    const body = buildDeployBody({ scope: "guild", guildId: GUILD, clear: false });
    expect(body.length).toBe(global.length);
    for (const command of body) {
      expect(command.contexts).toBeUndefined();
      expect(command.integration_types).toBeUndefined();
    }
  });

  test("the real modules: server-only commands stay in servers, help and ping go everywhere", () => {
    const guildOnly = {
      contexts: [InteractionContextType.Guild],
      integration_types: [ApplicationIntegrationType.GuildInstall],
    };
    for (const name of ["party", "welcome", "prefix", "modules"]) {
      expect(byName(name)).toMatchObject(guildOnly);
    }
    for (const name of ["help", "ping"]) {
      expect(byName(name)).toMatchObject({
        contexts: [
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        ],
        integration_types: [
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        ],
      });
    }
  });
});

describe("unusedServices", () => {
  interface Service {
    send(text: string): Promise<void>;
    nested: { read(): string };
  }

  test("throws when a function is called, at any depth", () => {
    const service = unusedServices<Service>();
    expect(() => service.send("x")).toThrow("not available while deploying");
    expect(() => service.nested.read()).toThrow("not available while deploying");
  });

  test("throws when the value is used as a string or number", () => {
    const service = unusedServices<Service>();
    expect(() => `${service.nested}`).toThrow("not available while deploying");
    expect(() => Number(service)).toThrow("not available while deploying");
  });

  test("passing the service around and awaiting it is harmless", async () => {
    const service = unusedServices<Service>();
    const held = { service, send: service.send };
    expect(held.send).toBeDefined();
    expect(await Promise.resolve(service)).toBe(service);
  });
});

type Json = Record<string, unknown>;

/** What Discord's GET returns for a deployed body (shape seen on the live API). */
function asDiscordReturnsIt(body: readonly object[], scope: DeployStep["scope"]): Json[] {
  const option = (o: Json): Json => {
    const { required, options, ...rest } = o;
    return {
      ...rest,
      ...(required ? { required } : {}),
      ...(Array.isArray(options) && options.length > 0 ? { options: options.map(option) } : {}),
    };
  };
  return [...body].reverse().map((command, index) => {
    const { options, default_member_permissions, ...rest } = command as Json;
    return {
      id: `15687047703849945${index}`,
      application_id: CLIENT,
      version: "1",
      default_member_permissions: default_member_permissions ?? null,
      dm_permission: true,
      nsfw: false,
      ...(scope === "guild" ? { integration_types: [0], contexts: null } : {}),
      ...rest,
      ...(Array.isArray(options) && options.length > 0 ? { options: options.map(option) } : {}),
    };
  });
}

describe("sameCommands", () => {
  for (const scope of ["guild", "global"] as const) {
    test(`matches what Discord returns for the same ${scope} set`, () => {
      const local = buildDeployBody(
        scope === "guild" ? { scope, guildId: GUILD, clear: false } : { scope, clear: false },
      );
      expect(sameCommands(local, asDiscordReturnsIt(local, scope), scope)).toBe(true);
    });
  }

  test("sees a changed description, a new option, new contexts and a removed command", () => {
    const local = buildDeployBody({ scope: "global", clear: false });
    const remote = () => asDiscordReturnsIt(local, "global");
    const edit = (change: (commands: Json[]) => void) => {
      const commands = remote();
      change(commands);
      return sameCommands(local, commands, "global");
    };
    const ping = (commands: Json[]) => commands.find((c) => c.name === "ping") as Json;
    expect(
      edit((c) => {
        ping(c).description = "old text";
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        ping(c).options = [{ type: 3, name: "x", description: "x" }];
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        ping(c).contexts = [0];
      }),
    ).toBe(false);
    expect(edit((c) => void c.pop())).toBe(false);
    expect(sameCommands(local, [], "global")).toBe(local.length === 0);
  });
});

describe("deployOnStartup", () => {
  const guildRoute = `/applications/${CLIENT}/guilds/${GUILD}/commands`;
  const globalRoute = `/applications/${CLIENT}/commands`;

  /** Discord with a command set per route; every call is recorded. */
  function fakeRest(sets: Record<string, unknown>, fail?: "get" | "put") {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    return {
      calls,
      bodies,
      async get(route: `/${string}`) {
        calls.push(`GET ${route}`);
        if (fail === "get") throw new Error("Missing Access");
        return sets[route] ?? [];
      },
      async put(route: `/${string}`, { body }: { body: unknown }) {
        calls.push(`PUT ${route}`);
        if (fail === "put") throw new Error("Missing Access");
        bodies[route] = body;
        return [];
      },
    };
  }

  function recordingLogger() {
    const lines: string[] = [];
    const record = (level: string) => (message: string) => void lines.push(`${level} ${message}`);
    const logger = {
      ...silentLogger,
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    };
    return { lines, logger };
  }

  const registry = createDeployRegistry();
  const guildBody = buildDeployBody({ scope: "guild", guildId: GUILD, clear: false }, registry);
  const globalBody = buildDeployBody({ scope: "global", clear: false }, registry);
  const run = (
    rest: ReturnType<typeof fakeRest>,
    options: { devGuildId?: string; global?: boolean } = {},
    logger = silentLogger,
  ) =>
    deployOnStartup({
      rest,
      clientId: CLIENT,
      devGuildId: options.devGuildId,
      global: options.global ?? false,
      registry,
      logger,
    });

  test("sends nothing when the dev guild already has the same set", async () => {
    const rest = fakeRest({ [guildRoute]: asDiscordReturnsIt(guildBody, "guild") });
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(rest.calls).toEqual([`GET ${guildRoute}`, `GET ${globalRoute}`]);
    expect(lines).toEqual(["info Slash commands are up to date"]);
  });

  test("puts the dev guild set when it differs and leaves the global set alone", async () => {
    const stale = asDiscordReturnsIt(guildBody, "guild").slice(1);
    const rest = fakeRest({ [guildRoute]: stale });
    await run(rest, { devGuildId: GUILD });
    expect(rest.calls).toEqual([`GET ${guildRoute}`, `PUT ${guildRoute}`, `GET ${globalRoute}`]);
    expect(rest.bodies[guildRoute]).toEqual(guildBody);
  });

  test("warns when a dev guild deploy sits next to a non-empty global set", async () => {
    const rest = fakeRest({
      [guildRoute]: asDiscordReturnsIt(guildBody, "guild"),
      [globalRoute]: asDiscordReturnsIt(globalBody, "global"),
    });
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(rest.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("warn"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("shows every command twice");
  });

  test("without a dev guild only the global set is read and written", async () => {
    const same = fakeRest({ [globalRoute]: asDiscordReturnsIt(globalBody, "global") });
    await run(same);
    expect(same.calls).toEqual([`GET ${globalRoute}`]);
    // A guild-shaped set lacks contexts and integration types, so the global one differs.
    const differs = fakeRest({ [globalRoute]: asDiscordReturnsIt(guildBody, "guild") });
    await run(differs);
    expect(differs.calls).toEqual([`GET ${globalRoute}`, `PUT ${globalRoute}`]);
  });

  test("DEPLOY_GLOBAL with a dev guild deploys globally and empties the dev guild", async () => {
    const rest = fakeRest({ [guildRoute]: asDiscordReturnsIt(guildBody, "guild") });
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD, global: true }, logger);
    expect(rest.calls).toEqual([
      `GET ${globalRoute}`,
      `PUT ${globalRoute}`,
      `GET ${guildRoute}`,
      `PUT ${guildRoute}`,
    ]);
    expect(rest.bodies[guildRoute]).toEqual([]);
    expect(lines).toEqual(["info Deployed slash commands", "info Cleared slash commands"]);

    // Already in that state: nothing to send.
    const settled = fakeRest({ [globalRoute]: asDiscordReturnsIt(globalBody, "global") });
    await run(settled, { devGuildId: GUILD, global: true });
    expect(settled.calls).toEqual([`GET ${globalRoute}`, `GET ${guildRoute}`]);
  });

  test("logs a failed read or write instead of throwing", async () => {
    for (const fail of ["get", "put"] as const) {
      const { lines, logger } = recordingLogger();
      await run(fakeRest({}, fail), { devGuildId: GUILD }, logger);
      expect(lines.filter((line) => line.startsWith("error"))).toEqual([
        "error Deploying slash commands failed",
      ]);
    }
  });

  test("COMMANDS_AUTO_DEPLOY is on unless switched off", () => {
    const env = {
      ...base,
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
    };
    expect(loadEnv(env).COMMANDS_AUTO_DEPLOY).toBe(true);
    expect(loadEnv({ ...env, COMMANDS_AUTO_DEPLOY: "" }).COMMANDS_AUTO_DEPLOY).toBe(true);
    expect(loadEnv({ ...env, COMMANDS_AUTO_DEPLOY: "true" }).COMMANDS_AUTO_DEPLOY).toBe(true);
    expect(loadEnv({ ...env, COMMANDS_AUTO_DEPLOY: "0" }).COMMANDS_AUTO_DEPLOY).toBe(false);
    expect(loadEnv({ ...env, COMMANDS_AUTO_DEPLOY: "false" }).COMMANDS_AUTO_DEPLOY).toBe(false);
    expect(loadEnv(env).DEPLOY_GLOBAL).toBe(false);
    expect(loadEnv({ ...env, DEPLOY_GLOBAL: "1" }).DEPLOY_GLOBAL).toBe(true);
  });
});
