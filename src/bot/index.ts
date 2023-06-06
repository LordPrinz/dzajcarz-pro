import DiscordJS, { Intents } from "discord.js";
import WOKCommands from "wokcommands";
import path from "path";
import Logger from "../utils/debug/Logger";
import setupChatListener from "./dmChatListener";

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

const logger = new Logger("dzajcarz");

client.on("ready", () => {
	new WOKCommands(client, {
		commandsDir: path.join(__dirname, "commands"),
		featuresDir: path.join(__dirname, "features"),
		testServers: ["928638782952079391"],
		botOwners: ["520676533279522817"],
		mongoUri: process.env.MONGO_URI,
		typeScript: true,
	}).setDefaultPrefix("*");

	logger.saveLog("Commands loaded", "info");
});

client.on("shardError", (error) => {
	logger.saveLog(`${error.name} ${error.message}`, "error");
});

client.on("error", (error) => {
	logger.saveLog(`${error.name} ${error.message}`, "error");
});

setupChatListener(client); // WebSocket for private chat

export default client;
