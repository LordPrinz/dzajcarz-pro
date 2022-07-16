import DiscordJS, { Intents } from "discord.js";
import WOKCommands from "wokcommands";
import dotenv from "dotenv";
import path from "path";
import { Player, Queue } from "discord-player";

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

const player = new Player(client, {
	ytdlOptions: {
		quality: "highestaudio",
		highWaterMark: 1 << 25,
	},
});

player.on("error", (queue, error) => {
	console.log(`Error emitted from the queue ${error.message}`);
	return;
});

player.on("connectionError", (queue, error) => {
	console.log(`Error emitted from the connection ${error.message}`);
	return;
});

player.on("trackStart", (queue: Queue<any>, track) => {
	if (queue?.repeatMode !== 0) return;
	queue?.metadata?.send(
		`Started playing ${track.title} in **${queue.connection.channel.name}** 🎧`
	);
	return;
});

player.on("trackAdd", (queue: Queue<any>, track) => {
	queue?.metadata?.send(
		`Track ${track.title} added in the queue ✅ \n${track.url}`
	);
	return;
});

player.on("botDisconnect", (queue: Queue<any>) => {
	queue?.metadata?.send(
		"I was manually disconnected from the voice channel, clearing queue... ❌"
	);
	return;
});

player.on("channelEmpty", (queue: Queue<any>) => {
	queue?.metadata?.send(
		"Nobody is in the voice channel, leaving the voice channel... ❌"
	);
	return;
});

player.on("queueEnd", (queue: Queue<any>) => {
	queue?.metadata?.send("I finished reading the whole queue ✅");
	return;
});

(globalThis as any).player = player;

client.login(process.env.TOKEN);
