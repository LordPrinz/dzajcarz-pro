import { Client } from "discord.js";
import { intents, partials } from "./conf/bot";

export const clinet = new Client({
	intents,
	partials,
});

clinet.on("ready", () => {
	console.log("Bot is ready");
});
