import {
	ChannelType,
	type Channel,
	type Client,
	type VoiceChannel,
} from "discord.js";

export const getAllVoiceChannels = async (
	client: Client,
	filter?: (channel: Channel) => boolean
) => {
	const voiceChannels: VoiceChannel[] = [];

	for (const channel of client.channels.cache) {
		const ch = channel[1];

		if (ch.type === ChannelType.GuildVoice && filter(ch)) {
			voiceChannels.push(ch);
		}
	}

	return Promise.all(voiceChannels);
};

export const pingUser = (id: string) => `<@${id}>`;

export const replaceTagToUser = (message: string, user: string) => {
	return message.replace(/@/g, user);
};
