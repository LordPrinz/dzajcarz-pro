import { type CommandRegistry, createRegistry, type Logger, silentLogger } from "@dzajcarz/core";
import { type RESTPostAPIChatInputApplicationCommandsJSONBody, Routes } from "discord.js";
import { toSlashCommand } from "./discord/slash.ts";
import type { DeployEnv } from "./env.ts";
import { createModules } from "./modules.ts";
import { createUnavailableMusicPlayer } from "./music/unavailable.ts";

/** One PUT to Discord: set or empty the commands of the application or of one guild. */
export type DeployStep =
  | { scope: "global"; clear: boolean }
  | { scope: "guild"; guildId: string; clear: boolean };

/**
 * What a deploy does for this environment. `DEPLOY_CLEAR` empties the global set. `DEPLOY_GLOBAL` sets the
 * global commands and, when a dev guild is configured, empties that guild so nothing shows up twice.
 * Otherwise the dev guild (or global without one) gets the commands.
 */
export function deployTarget(
  env: Pick<DeployEnv, "DISCORD_DEV_GUILD_ID" | "DEPLOY_GLOBAL" | "DEPLOY_CLEAR">,
): DeployStep[] {
  const guildId = env.DISCORD_DEV_GUILD_ID;
  if (env.DEPLOY_CLEAR) return [{ scope: "global", clear: true }];
  if (env.DEPLOY_GLOBAL) {
    return [
      { scope: "global", clear: false },
      ...(guildId ? [{ scope: "guild", guildId, clear: true } as const] : []),
    ];
  }
  return guildId
    ? [{ scope: "guild", guildId, clear: false }]
    : [{ scope: "global", clear: false }];
}

export const deployRoute = (clientId: string, step: DeployStep) =>
  step.scope === "global"
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, step.guildId);

export function buildDeployBody(
  step: DeployStep,
  registry = createDeployRegistry(),
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  if (step.clear) return [];
  return registry.commands().map((command) => toSlashCommand(command, step.scope));
}

/** The slice of discord.js `REST` a deploy uses. */
export interface CommandRest {
  put(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

export interface StartupDeployOptions {
  rest: CommandRest;
  clientId: string;
  devGuildId: string | undefined;
  registry: CommandRegistry;
  logger: Logger;
}

/**
 * Registers the commands of this build when the bot starts: in the dev guild when one is set, otherwise
 * globally, like a plain `commands:deploy`. The PUT replaces the whole set, so it also repairs a guild
 * emptied by `DEPLOY_GLOBAL` / `DEPLOY_CLEAR`; an unchanged set creates nothing new on Discord's side.
 * Never throws: the bot keeps running with whatever Discord has, and the error is logged.
 */
export async function deployOnStartup({
  rest,
  clientId,
  devGuildId,
  registry,
  logger,
}: StartupDeployOptions): Promise<void> {
  const [step] = deployTarget({
    DISCORD_DEV_GUILD_ID: devGuildId,
    DEPLOY_GLOBAL: false,
    DEPLOY_CLEAR: false,
  });
  if (!step) return;
  const where = step.scope === "global" ? "global" : step.guildId;
  try {
    const body = buildDeployBody(step, registry);
    await rest.put(deployRoute(clientId, step), { body });
    logger.info("Deployed slash commands", { where, count: body.length });
  } catch (error) {
    logger.error("Deploying slash commands failed", { where, error });
  }
}

const NOT_AVAILABLE = "Module services are not available while deploying commands";

/**
 * A stand-in for a service the deploy never calls: only command definitions are needed, so any call or use
 * of the value throws. Reading a property gives another stand-in, so `deps.channels.isThread` can be passed
 * around without a stub per method.
 */
export function unusedServices<T>(): T {
  const fail = (): never => {
    throw new Error(NOT_AVAILABLE);
  };
  const stand = (): unknown =>
    new Proxy(fail, {
      get: (_target, key) => {
        // A promise check (`await`, `Promise.resolve`) probes `then`; answering undefined keeps it a plain value.
        if (key === "then") return undefined;
        if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") return fail;
        return stand();
      },
    });
  return stand() as T;
}

export const createDeployRegistry = () =>
  createRegistry(
    createModules({
      commands: unusedServices(),
      gatewayPing: unusedServices(),
      prefixFor: unusedServices(),
      installLinks: { guild: "", user: "" },
      botInGuild: unusedServices(),
      moduleEnabled: unusedServices(),
      prefixSettings: unusedServices(),
      moduleToggles: unusedServices(),
      channels: unusedServices(),
      defaultPrefix: "",
      welcomeConfigs: unusedServices(),
      welcomeSender: unusedServices(),
      guildLookup: unusedServices(),
      partyAreas: unusedServices(),
      partyChannels: unusedServices(),
      partyPermissions: unusedServices(),
      partyChat: unusedServices(),
      scheduler: unusedServices(),
      partyLock: unusedServices(),
      // The music module subscribes to its player when it is created.
      musicPlayer: createUnavailableMusicPlayer(),
      voiceChannels: unusedServices(),
      musicPanels: unusedServices(),
      componentState: unusedServices(),
      presence: unusedServices(),
      clock: unusedServices(),
      logger: silentLogger,
    }),
  );
