import DiscordJS, { Intents } from "discord.js";
import WOKCommands from "wokcommands";
import dotenv from "dotenv";
import path from "path";
import { createWarningLog } from "./utilities/loger";

dotenv.config();

const client = new DiscordJS.Client({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
		Intents.FLAGS.GUILD_VOICE_STATES,
		Intents.FLAGS.GUILD_MEMBERS,
		Intents.FLAGS.DIRECT_MESSAGES,
		Intents.FLAGS.DIRECT_MESSAGE_TYPING,
		Intents.FLAGS.DIRECT_MESSAGE_REACTIONS,
	],
	partials: ["CHANNEL", "MESSAGE", "REACTION"],
});

client.on("ready", () => {
	new WOKCommands(client, {
		commandsDir: path.join(__dirname, "commands"),
		featuresDir: path.join(__dirname, "features"),
		testServers: ["928638782952079391"],
		botOwners: ["520676533279522817"],
		mongoUri: process.env.MONGO_URI,
		typeScript: true,
	}).setDefaultPrefix("*");
});

client.on("shardError", (error) => {
	createWarningLog(error);
});

client.on("error", (error) => {
	createWarningLog(error);
});

if (process.env.NODE_ENV === "development") {
	client.login(process.env.DEV_TOKEN);
}

if (process.env.NODE_ENV === "production") {
	client.login(process.env.PROD_TOKEN);
}

export default client;