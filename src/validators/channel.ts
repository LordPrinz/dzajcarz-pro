import { Channel, ChannelType } from "discord.js";

export const isCategoryChannel = (channel: Channel) =>
	channel.type === ChannelType.GuildCategory;

export const isVoiceChannel = (channel: Channel) =>
	channel.type === ChannelType.GuildVoice;
