import { Client } from "discord.js";

import WOK from "wokcommands";
import path from "path";

import { intents, partials } from "@/conf/bot";
import { syncVCRedis } from "./helpers/redis";

export const client = new Client({
	intents,
	partials,
});

client.on("ready", async () => {
	new WOK({
		client,
		defaultPrefix: "$",
		mongoUri: process.env.MONGO_URI,
		commandsDir: path.join(__dirname, "commands"),
		events: {
			dir: path.join(__dirname, "events"),
		},
		featuresDir: path.join(__dirname, "features"),
		botOwners: ["520676533279522817"],
		testServers: ["928638782952079391"],
	});

	console.log(`Logged in as ${client.user?.tag}!`);

	// Sync VC with redis

	// await syncPartyRedisMongo();

	await syncVCRedis(client);
});
