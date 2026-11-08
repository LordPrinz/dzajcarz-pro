import { describe, expect, test } from "bun:test";
import { defineCommand, type Logger, silentLogger } from "@dzajcarz/core";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
} from "discord.js";
import {
  buildDeployBody,
  createDeployRegistry,
  type DeployStep,
  deployOnStartup,
  deployRoute,
  deployTarget,
  HANDLED_CHOICE_KEYS,
  HANDLED_COMMAND_KEYS,
  HANDLED_OPTION_KEYS,
  sameCommands,
  unusedServices,
} from "./deploy.ts";
import { toSlashCommand } from "./discord/slash.ts";
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

const noop = async () => {};
const everyOptionType = defineCommand({
  name: "synthetic",
  description: "Uses every option type",
  permissions: PermissionFlagsBits.ManageGuild,
  options: {
    text: {
      type: "string",
      description: "t",
      required: true,
      choices: [{ name: "A", value: "a" }],
    },
    count: {
      type: "integer",
      description: "c",
      minValue: 1,
      maxValue: 5,
      choices: [{ name: "One", value: 1 }],
    },
    ratio: { type: "number", description: "r", minValue: 0.5, maxValue: 2 },
    flag: { type: "boolean", description: "f" },
    who: { type: "user", description: "u" },
    where: { type: "channel", description: "ch" },
    which: { type: "role", description: "ro" },
  },
  run: noop,
});
const withSubcommands = defineCommand({
  name: "grouped",
  description: "Subcommands",
  subcommands: {
    one: {
      description: "one",
      options: { x: { type: "string", description: "x", required: true } },
      run: noop,
    },
  },
});

describe("field whitelist", () => {
  const collect = (commands: readonly object[]) => {
    const keys = {
      command: new Set<string>(),
      option: new Set<string>(),
      choice: new Set<string>(),
    };
    const visitOption = (option: Json) => {
      for (const key of Object.keys(option)) keys.option.add(key);
      for (const choice of (option.choices as Json[] | undefined) ?? []) {
        for (const key of Object.keys(choice)) keys.choice.add(key);
      }
      for (const nested of (option.options as Json[] | undefined) ?? []) visitOption(nested);
    };
    for (const command of commands as Json[]) {
      for (const key of Object.keys(command)) keys.command.add(key);
      for (const option of (command.options as Json[] | undefined) ?? []) visitOption(option);
    }
    return keys;
  };

  test("every key the real modules and a synthetic command emit is compared by the up-to-date check", () => {
    const real = createDeployRegistry().commands();
    const keys = collect(
      [...real, everyOptionType, withSubcommands].flatMap((command) => [
        toSlashCommand(command, "global"),
        toSlashCommand(command, "guild"),
      ]),
    );
    expect([...keys.command].filter((k) => !HANDLED_COMMAND_KEYS.includes(k))).toEqual([]);
    expect([...keys.option].filter((k) => !HANDLED_OPTION_KEYS.includes(k))).toEqual([]);
    expect([...keys.choice].filter((k) => !HANDLED_CHOICE_KEYS.includes(k))).toEqual([]);
    // The synthetic commands reach the keys the real set may not use yet.
    expect(keys.option).toContain("min_value");
    expect(keys.option).toContain("choices");
    expect(keys.choice).toContain("value");
  });
});

describe("sameCommands against Discord's own shape", () => {
  const local = [
    toSlashCommand(everyOptionType, "global"),
    toSlashCommand(withSubcommands, "global"),
  ];
  /** The synthetic set as Discord returns it, with its extra fields. */
  const discord = (): Json[] =>
    local.map((command, index) => {
      const { options, ...rest } = JSON.parse(JSON.stringify(command)) as Json;
      const wrap = (o: Json): Json => ({
        ...o,
        name_localizations: null,
        description_localizations: null,
        ...(o.required === false ? { required: undefined } : {}),
        ...(Array.isArray(o.options) ? { options: (o.options as Json[]).map(wrap) } : {}),
      });
      return {
        id: `15687047703849945${index}`,
        application_id: CLIENT,
        guild_id: GUILD,
        version: "1687047703849945",
        name_localizations: null,
        description_localizations: null,
        dm_permission: true,
        nsfw: false,
        ...rest,
        options: (options as Json[]).map(wrap),
      };
    });
  const edit = (change: (commands: Json[]) => void) => {
    const commands = discord();
    change(commands);
    return sameCommands(local, commands, "global");
  };
  const synthetic = (commands: Json[]) => commands.find((c) => c.name === "synthetic") as Json;
  const option = (commands: Json[], name: string) =>
    (synthetic(commands).options as Json[]).find((o) => o.name === name) as Json;

  test("is the same despite ids, versions, localizations, nsfw and omitted defaults", () => {
    expect(edit(() => {})).toBe(true);
  });

  test("sees a changed choice, a required flip, a changed bound and a permission change", () => {
    expect(
      edit((c) => {
        (option(c, "text").choices as Json[])[0] = { name: "A", value: "b" };
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        option(c, "text").required = false;
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        option(c, "flag").required = true;
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        option(c, "count").max_value = 6;
      }),
    ).toBe(false);
    expect(
      edit((c) => {
        synthetic(c).default_member_permissions = "8";
      }),
    ).toBe(false);
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

  /** A logger that records `[level, message, fields]` per call. */
  function recordingLogger() {
    const lines: [string, string, Record<string, unknown> | undefined][] = [];
    const at = (level: string) => (message: string, fields?: Record<string, unknown>) =>
      void lines.push([level, message, fields]);
    const logger: Logger = {
      ...silentLogger,
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    };
    /** `level message` per line above debug, for comparing the whole log. */
    const summary = () =>
      lines.filter(([level]) => level !== "debug").map(([level, message]) => `${level} ${message}`);
    return { lines, logger, summary };
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
    const { logger, summary } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(rest.calls).toEqual([`GET ${guildRoute}`, `GET ${globalRoute}`]);
    // An empty global set is not worth a warning.
    expect(summary()).toEqual(["info Slash commands are up to date"]);
  });

  test("puts the dev guild set when it differs and leaves the global set alone", async () => {
    const stale = asDiscordReturnsIt(guildBody, "guild").slice(1);
    const rest = fakeRest({ [guildRoute]: stale });
    await run(rest, { devGuildId: GUILD });
    expect(rest.calls).toEqual([`GET ${guildRoute}`, `PUT ${guildRoute}`, `GET ${globalRoute}`]);
    expect(rest.bodies[guildRoute]).toEqual(guildBody);
  });

  test("logs the names it deployed and, at debug level, which command differed", async () => {
    const remote = asDiscordReturnsIt(guildBody, "guild");
    (remote.find((c) => c.name === "ping") as Json).description = "old text";
    const { lines, logger } = recordingLogger();
    await run(fakeRest({ [guildRoute]: remote }), { devGuildId: GUILD }, logger);
    expect(lines).toContainEqual([
      "debug",
      "Slash commands differ",
      { where: GUILD, differing: ["ping"] },
    ]);
    const deployed = lines.find(([, message]) => message === "Deployed slash commands");
    expect(deployed?.[2]?.names).toEqual(guildBody.map((c) => c.name));
  });

  test("warns about, but still sends, a non-array answer", async () => {
    const rest = fakeRest({ [guildRoute]: { message: "nope" } });
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(
      lines.some(([level, message]) => level === "warn" && message.includes("unexpected")),
    ).toBe(true);
    expect(rest.calls).toContain(`PUT ${guildRoute}`);
  });

  test("warns when global commands duplicate the dev guild, and deletes nothing", async () => {
    const rest = fakeRest({
      [guildRoute]: asDiscordReturnsIt(guildBody, "guild"),
      [globalRoute]: asDiscordReturnsIt(globalBody, "global"),
    });
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(rest.calls.some((call) => call.startsWith("PUT"))).toBe(false);
    const warnings = lines.filter(([level]) => level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toBe("Global commands duplicate the dev guild");
    expect(warnings[0]?.[2]).toMatchObject({ count: globalBody.length });
    expect(String(warnings[0]?.[2]?.hint)).toContain("DEPLOY_CLEAR=1 bun run commands:deploy");
    expect(String(warnings[0]?.[2]?.hint)).toContain("DEPLOY_GLOBAL=1");
  });

  test("a failed read of the global commands is only logged", async () => {
    const rest = {
      ...fakeRest({}),
      async get(route: `/${string}`) {
        if (route === globalRoute) throw new Error("boom");
        return asDiscordReturnsIt(guildBody, "guild");
      },
    };
    const { lines, logger } = recordingLogger();
    await run(rest, { devGuildId: GUILD }, logger);
    expect(lines.filter(([level]) => level === "error")).toEqual([]);
    expect(lines.some(([level, message]) => level === "warn" && message.includes("global"))).toBe(
      true,
    );
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
    const { logger, summary } = recordingLogger();
    await run(rest, { devGuildId: GUILD, global: true }, logger);
    expect(rest.calls).toEqual([
      `GET ${globalRoute}`,
      `PUT ${globalRoute}`,
      `GET ${guildRoute}`,
      `PUT ${guildRoute}`,
    ]);
    expect(rest.bodies[guildRoute]).toEqual([]);
    expect(summary()).toEqual(["info Deployed slash commands", "info Cleared slash commands"]);

    // Already in that state: nothing to send, and the global set is the target, not a duplicate.
    const settled = fakeRest({ [globalRoute]: asDiscordReturnsIt(globalBody, "global") });
    const quiet = recordingLogger();
    await run(settled, { devGuildId: GUILD, global: true }, quiet.logger);
    expect(settled.calls).toEqual([`GET ${globalRoute}`, `GET ${guildRoute}`]);
    expect(quiet.lines.some(([level]) => level === "warn")).toBe(false);
  });

  test("logs a failed read or write instead of throwing", async () => {
    for (const fail of ["get", "put"] as const) {
      const { lines, logger } = recordingLogger();
      await run(fakeRest({}, fail), { devGuildId: GUILD }, logger);
      expect(lines.filter(([level]) => level === "error").map(([, message]) => message)).toEqual([
        "Deploying slash commands failed",
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
