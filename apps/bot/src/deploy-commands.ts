// Registers slash commands with Discord: in DISCORD_DEV_GUILD_ID when set (instant), otherwise
// globally (may take a while to show up). Guild commands cannot be used in DMs or installed on a user, so
// to try those, deploy globally even when a dev guild is set:
//   bun run commands:deploy                    dev guild if DISCORD_DEV_GUILD_ID is set, else global
//   DEPLOY_GLOBAL=1 bun run commands:deploy    always global (DMs, user install)
import { createRegistry, silentLogger } from "@dzajcarz/core";
import { REST, Routes } from "discord.js";
import { toSlashCommand } from "./discord/slash.ts";
import { loadDeployEnv } from "./env.ts";
import { createModules } from "./modules.ts";

const env = loadDeployEnv();

// Only the definitions are needed; nothing runs, so the services are never called.
const unused = () => {
  throw new Error("Module services are not available while deploying commands");
};
const registry = createRegistry(
  createModules({
    commands: unused,
    gatewayPing: unused,
    prefixFor: unused,
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
const devGuildId = Bun.env.DEPLOY_GLOBAL === "1" ? undefined : env.DISCORD_DEV_GUILD_ID;
const body = registry
  .commands()
  .map((command) => toSlashCommand(command, devGuildId ? "guild" : "global"));

const rest = new REST().setToken(env.DISCORD_TOKEN);
const route = devGuildId
  ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, devGuildId)
  : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

// PUT replaces the whole set, so commands removed from the code disappear from Discord too.
await rest.put(route, { body });
console.info(
  `Deployed ${body.length} slash commands ${devGuildId ? `to guild ${devGuildId}` : "globally"}: ${body.map((c) => c.name).join(", ")}`,
);
