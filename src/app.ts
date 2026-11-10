import { Client } from "discord.js";

import WOK from "wokcommands";
import path from "path";

import { botOwners, intents, partials, testServers } from "@/conf/bot";
import { syncCoRedis, syncPartyRedisMongo, syncVCRedis } from "./helpers/redis";
import { configureRedis } from "./lib/redisClient";

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
		botOwners,
		testServers,
	});

	console.log(`Logged in as ${client.user?.tag}!`);

	// Sync VC with redis

	await configureRedis();

	await syncPartyRedisMongo();

	await syncVCRedis(client);

	await syncCoRedis();
});
