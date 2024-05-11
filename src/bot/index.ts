import { Client } from "discord.js";
import { intents, partials } from "./conf/bot";
import path from "path";

import WOK from "wokcommands";

export const client = new Client({
	intents,
	partials,
});

client.on("ready", () => {
	new WOK({
		client,
		commandsDir: path.join(__dirname, "commands"),
		events: {
			dir: path.join(__dirname, "events"),
		},
		validations: {
			runtime: path.join(__dirname, "validations", "runtime"),
			syntax: path.join(__dirname, "validations", "syntax"),
		},
		botOwners: ["520676533279522817"],
	});
});
