import { type CommandRegistry, createRegistry, type Logger, silentLogger } from "@dzajcarz/core";
import { type RESTPostAPIChatInputApplicationCommandsJSONBody, Routes } from "discord.js";
import { toSlashCommand } from "./discord/slash.ts";
import type { DeployEnv } from "./env.ts";
import { createModules } from "./modules.ts";
import { SCHEDULED_SONGS } from "./music/scheduled-songs.ts";
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

type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;

/** The fields of a command or option that `toSlashCommand` sets, read loosely from either side. */
interface LooseCommand {
  type?: number;
  name?: string;
  description?: string;
  required?: boolean;
  default_member_permissions?: string | null;
  integration_types?: readonly number[] | null;
  contexts?: readonly number[] | null;
  choices?: readonly { name: string; value: string | number }[] | null;
  min_value?: number | null;
  max_value?: number | null;
  options?: readonly LooseCommand[] | null;
}

/**
 * The keys `canonicalCommand` and `canonicalOptions` compare, per level. A key `toSlashCommand` emits that is
 * missing here would be ignored by the "is Discord up to date" check, so a test fails when the two drift.
 */
export const HANDLED_COMMAND_KEYS: readonly string[] = [
  "type",
  "name",
  "description",
  "default_member_permissions",
  "options",
  "integration_types",
  "contexts",
];
export const HANDLED_OPTION_KEYS: readonly string[] = [
  "type",
  "name",
  "description",
  "required",
  "choices",
  "min_value",
  "max_value",
  "options",
];
export const HANDLED_CHOICE_KEYS: readonly string[] = ["name", "value"];

function canonicalOptions(options: readonly LooseCommand[] | null | undefined): unknown[] {
  // Order matters: it is the order of prefix arguments and of the options in Discord's picker.
  return (options ?? []).map((option) => ({
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    choices: (option.choices ?? []).map(({ name, value }) => ({ name, value })),
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    options: canonicalOptions(option.options),
  }));
}

/**
 * A command reduced to what we send, with Discord's defaults filled in: Discord leaves out empty `options`
 * and `required: false` and adds `id`, `version`, `nsfw` and the like. Guild commands carry no
 * `integration_types` / `contexts` from us, so those are compared for the global set only.
 */
function canonicalCommand(command: LooseCommand, scope: DeployStep["scope"]): unknown {
  const sorted = (values: readonly number[] | null | undefined) =>
    [...(values ?? [])].sort((a, b) => a - b);
  return {
    type: command.type ?? 1,
    name: command.name,
    description: command.description,
    default_member_permissions: command.default_member_permissions ?? null,
    options: canonicalOptions(command.options),
    ...(scope === "global" && {
      integration_types: sorted(command.integration_types),
      contexts: sorted(command.contexts),
    }),
  };
}

/** Whether Discord already has exactly `local` (in any command order). */
export function sameCommands(
  local: readonly CommandBody[],
  remote: readonly LooseCommand[],
  scope: DeployStep["scope"],
): boolean {
  const canonical = (commands: readonly LooseCommand[]) =>
    JSON.stringify(
      [...commands]
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
        .map((command) => canonicalCommand(command, scope)),
    );
  return canonical(local as readonly LooseCommand[]) === canonical(remote);
}

/** The slice of discord.js `REST` the startup deploy uses. */
export interface CommandRest {
  get(route: `/${string}`): Promise<unknown>;
  put(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

export interface StartupDeployOptions {
  rest: CommandRest;
  clientId: string;
  devGuildId: string | undefined;
  /** `DEPLOY_GLOBAL`: the global set even with a dev guild, which is then emptied. */
  global: boolean;
  registry: CommandRegistry;
  logger: Logger;
}

/**
 * Registers this build's commands when the bot starts, where `commands:deploy` would (`deployTarget`,
 * without `DEPLOY_CLEAR`): the dev guild when one is set, otherwise the global set; with `global`, the
 * global set plus an emptied dev guild. Each target is read first and written only when it differs, so
 * restarts do not spend the command rate limit. In dev guild mode a non-empty global set is reported,
 * because members of the dev guild then see every command twice. Never throws: a failure is logged and the
 * bot keeps the commands Discord already has.
 */
export async function deployOnStartup({
  rest,
  clientId,
  devGuildId,
  global,
  registry,
  logger,
}: StartupDeployOptions): Promise<void> {
  const steps = deployTarget({
    DISCORD_DEV_GUILD_ID: devGuildId,
    DEPLOY_GLOBAL: global,
    DEPLOY_CLEAR: false,
  });
  for (const step of steps) {
    const where = step.scope === "global" ? "global" : step.guildId;
    try {
      const route = deployRoute(clientId, step);
      const body = buildDeployBody(step, registry);
      const remote = await rest.get(route);
      if (!Array.isArray(remote)) {
        logger.warn("Discord returned an unexpected command list; sending the set anyway", {
          where,
        });
      } else if (sameCommands(body, remote, step.scope)) {
        logger.info("Slash commands are up to date", { where, count: body.length });
        continue;
      } else {
        logger.debug("Slash commands differ", {
          where,
          differing: differingNames(body, remote, step.scope),
        });
      }
      await rest.put(route, { body });
      logger.info(step.clear ? "Cleared slash commands" : "Deployed slash commands", {
        where,
        count: body.length,
        names: body.map((command) => command.name),
      });
    } catch (error) {
      logger.error("Deploying slash commands failed", { where, error });
    }
  }
  if (!steps.some((step) => step.scope === "global")) {
    await warnOnGlobalDuplicates({ rest, clientId, logger });
  }
}

/** Names of the commands added, removed or changed between the local and the remote set. */
function differingNames(
  local: readonly CommandBody[],
  remote: readonly LooseCommand[],
  scope: DeployStep["scope"],
): string[] {
  const keyed = (commands: readonly LooseCommand[]) =>
    new Map(
      commands.map((command) => [command.name, JSON.stringify(canonicalCommand(command, scope))]),
    );
  const before = keyed(remote);
  const after = keyed(local as readonly LooseCommand[]);
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).map(String);
}

/**
 * In dev guild mode a leftover global set shows every command twice. Only warns: deleting global commands
 * is the user's call (`DEPLOY_CLEAR=1 bun run commands:deploy`). A failed read is logged and nothing more.
 */
async function warnOnGlobalDuplicates({
  rest,
  clientId,
  logger,
}: Pick<StartupDeployOptions, "rest" | "clientId" | "logger">): Promise<void> {
  try {
    const remoteGlobal = await rest.get(Routes.applicationCommands(clientId));
    if (Array.isArray(remoteGlobal) && remoteGlobal.length > 0) {
      logger.warn("Global commands duplicate the dev guild", {
        count: remoteGlobal.length,
        hint: "run DEPLOY_CLEAR=1 bun run commands:deploy, or start the bot with DEPLOY_GLOBAL=1",
      });
    }
  } catch (error) {
    logger.warn("Reading the global commands failed", { error });
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
      partyInvites: unusedServices(),
      scheduler: unusedServices(),
      partyLock: unusedServices(),
      // The music module subscribes to its player when it is created.
      musicPlayer: createUnavailableMusicPlayer(),
      voiceChannels: unusedServices(),
      musicPanels: unusedServices(),
      directMessages: unusedServices(),
      componentState: unusedServices(),
      presence: unusedServices(),
      clock: unusedServices(),
      // The schedule module registers its cron job when it is created; nothing must fire while deploying.
      cron: { every: () => () => {} },
      scheduleSettings: unusedServices(),
      scheduleVoice: unusedServices(),
      scheduledSongPlayer: unusedServices(),
      scheduledSongs: SCHEDULED_SONGS,
      scheduledSongCron: { expression: "0 9,21 * * *", timeZone: "Europe/Warsaw" },
      dzajcoSettings: unusedServices(),
      dzajcoResponder: unusedServices(),
      dzajcoStore: unusedServices(),
      // moderation
      moderationGuild: unusedServices(),
      moderationLog: unusedServices(),
      moderationDmLimit: unusedServices(),
      riotStats: {},
      riotStore: unusedServices(),
      // messages (its cron job is the shared stand-in above, so nothing is sent while deploying)
      scheduledMessages: unusedServices(),
      scheduledMessageSender: unusedServices(),
      guildModuleEnabled: unusedServices(),
      messageLock: unusedServices(),
      messageChannels: unusedServices(),
      logger: silentLogger,
    }),
  );
