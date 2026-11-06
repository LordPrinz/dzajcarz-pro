// Registers slash commands with Discord: in DISCORD_DEV_GUILD_ID when set (instant), otherwise
// globally (may take a while to show up). Run after adding, renaming or removing a command:
//   bun run commands:deploy
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
    channels: { belongsTo: unused, isTextChannelOf: unused },
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
      allowMember: unused,
      denyMember: unused,
      clearMember: unused,
      setLimit: unused,
      rename: unused,
      disconnect: unused,
      lookupMember: unused,
    },
    partyLock: { setIfAbsent: unused, delIfEquals: unused, increment: unused },
    presence: { setActivity: unused },
    clock: { setInterval: unused, clearInterval: unused },
    logger: silentLogger,
  }),
);
const body = registry.commands().map(toSlashCommand);

const rest = new REST().setToken(env.DISCORD_TOKEN);
const route = env.DISCORD_DEV_GUILD_ID
  ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID)
  : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

// PUT replaces the whole set, so commands removed from the code disappear from Discord too.
await rest.put(route, { body });
console.info(
  `Deployed ${body.length} slash commands ${env.DISCORD_DEV_GUILD_ID ? `to guild ${env.DISCORD_DEV_GUILD_ID}` : "globally"}: ${body.map((c) => c.name).join(", ")}`,
);
