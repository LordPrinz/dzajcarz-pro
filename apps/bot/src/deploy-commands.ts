// Registers slash commands with Discord: in DISCORD_DEV_GUILD_ID when set (instant), otherwise
// globally (may take a while to show up). Guild commands cannot be used in DMs or installed on a user, so
// to try those, deploy globally even when a dev guild is set:
//   bun run commands:deploy                    dev guild if DISCORD_DEV_GUILD_ID is set, else global
//   DEPLOY_GLOBAL=1 bun run commands:deploy    global, and empties the dev guild so nothing shows twice
//   DEPLOY_CLEAR=1 bun run commands:deploy     empties the global set (back to dev-guild mode)
import { REST } from "discord.js";
import { buildDeployBody, deployRoute, deployTarget } from "./deploy.ts";
import { loadDeployEnv } from "./env.ts";

const env = loadDeployEnv();
const rest = new REST().setToken(env.DISCORD_TOKEN);

// PUT replaces the whole set, so commands removed from the code disappear from Discord too.
for (const step of deployTarget(env)) {
  const body = buildDeployBody(step);
  await rest.put(deployRoute(env.DISCORD_CLIENT_ID, step), { body });
  const where = step.scope === "global" ? "globally" : `to guild ${step.guildId}`;
  console.info(
    step.clear
      ? `Cleared slash commands ${where}`
      : `Deployed ${body.length} slash commands ${where}: ${body.map((c) => c.name).join(", ")}`,
  );
}
