import { createRegistry, silentLogger } from "@dzajcarz/core";
import { type RESTPostAPIChatInputApplicationCommandsJSONBody, Routes } from "discord.js";
import { toSlashCommand } from "./discord/slash.ts";
import type { DeployEnv } from "./env.ts";
import { createModules } from "./modules.ts";

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

// Only the definitions are needed; nothing runs, so the services are never called.
const unused = () => {
  throw new Error("Module services are not available while deploying commands");
};
export const createDeployRegistry = () =>
  createRegistry(
    createModules({
      commands: unused,
      gatewayPing: unused,
      prefixFor: unused,
      installLinks: { guild: "", user: "" },
      botInGuild: unused,
      moduleEnabled: unused,
      prefixSettings: { get: unused, set: unused, reset: unused },
      moduleToggles: { moduleNames: unused, list: unused, disable: unused, enable: unused },
      channels: { belongsTo: unused, isThread: unused, isTextChannelOf: unused },
      defaultPrefix: "",
      welcomeConfigs: { get: unused, set: unused, delete: unused },
      welcomeSender: { send: unused },
      guildLookup: { describe: unused },
      partyAreas: {
        addArea: unused,
        listAreas: unused,
        listAllAreas: unused,
        findAreaByJoinChannel: unused,
        findAreaByCategory: unused,
        deleteArea: unused,
        addChannel: unused,
        findChannel: unused,
        findChannelByOwner: unused,
        listChannelsOfArea: unused,
        listChannels: unused,
        deleteChannel: unused,
        transferOwner: unused,
      },
      partyChannels: {
        createVoiceChannel: unused,
        moveMember: unused,
        deleteChannel: unused,
        members: unused,
        exists: unused,
        createCategoryWithJoinChannel: unused,
        voiceChannelOf: unused,
      },
      partyPermissions: {
        setEveryone: unused,
        inheritedEveryone: unused,
        allowSelf: unused,
        allowMember: unused,
        denyMember: unused,
        clearMember: unused,
        setLimit: unused,
        rename: unused,
        disconnect: unused,
        lookupMember: unused,
        canManage: unused,
      },
      partyLock: { setIfAbsent: unused, delIfEquals: unused, increment: unused },
      presence: { setActivity: unused },
      clock: { setInterval: unused, clearInterval: unused },
      logger: silentLogger,
    }),
  );
