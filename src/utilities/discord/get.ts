import { Guild } from "discord.js";

export const getGuildVCs = (guild: Guild) => {
	return guild.channels.cache.filter((channel) => channel.type === "GUILD_VOICE");
};

export const getGuildTextChannels = (guild: Guild) => {
	return guild.channels.cache.filter((channel) => channel.type === "GUILD_TEXT");
};
