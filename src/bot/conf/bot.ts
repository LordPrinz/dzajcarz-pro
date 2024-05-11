import { GatewayIntentBits, Partials } from "discord.js";

export const intents = [
	GatewayIntentBits.Guilds,
	GatewayIntentBits.GuildMessages,
	GatewayIntentBits.GuildMessageReactions,
	GatewayIntentBits.GuildVoiceStates,
	GatewayIntentBits.GuildMembers,
	GatewayIntentBits.DirectMessages,
	GatewayIntentBits.DirectMessageReactions,
];

export const partials = [Partials.Message, Partials.Channel, Partials.Reaction];
