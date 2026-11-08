import { describe, expect, test } from "bun:test";
import { ApplicationIntegrationType, InteractionContextType } from "discord.js";
import { buildDeployBody, deployRoute, deployTarget, unusedServices } from "./deploy.ts";
import { loadDeployEnv } from "./env.ts";

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
