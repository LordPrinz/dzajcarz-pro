import { GatewayIntentBits, Partials } from "discord.js";

export const intents = [
	GatewayIntentBits.Guilds,
	GatewayIntentBits.GuildMessages,
	GatewayIntentBits.GuildMessageReactions,
	GatewayIntentBits.MessageContent,
	GatewayIntentBits.GuildVoiceStates,
	GatewayIntentBits.GuildMembers,
	GatewayIntentBits.DirectMessages,
	GatewayIntentBits.DirectMessageReactions,
];

export const partials = [Partials.Message, Partials.Channel, Partials.Reaction];

export const dzajcoRegex =
	/\b[cC][oO]\b|\b[cC][oO]\??\b|\b[cC][oO]\s?\b|\b[cC][oO]{2,}\b|\b[cC][oO]o\s+aaa\b/m;

export const dzajcoGifUrl = "https://tenor.com/view/jajco-gif-23924347";
