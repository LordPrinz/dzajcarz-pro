import { Client } from "discord.js";

import WOK from "wokcommands";
import path from "path";

import { intents, partials } from "@/conf/bot";

export const client = new Client({
	intents,
	partials,
});

client.on("ready", () => {
	new WOK({
		client,
		defaultPrefix: "!",
		mongoUri: process.env.MONGO_URI,
		commandsDir: path.join(__dirname, "commands"),
		events: {
			dir: path.join(__dirname, "events"),
		},
		validations: {
			runtime: path.join(__dirname, "validations", "runtime"),
			syntax: path.join(__dirname, "validations", "syntax"),
		},
		featuresDir: path.join(__dirname, "features"),
		botOwners: ["520676533279522817"],
		testServers: ["928638782952079391"],
	});

	console.log(`Logged in as ${client.user?.tag}!`);
});
