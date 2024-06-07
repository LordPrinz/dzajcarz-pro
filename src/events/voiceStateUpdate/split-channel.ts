import { type VoiceState } from "discord.js";

export default async (oldState: VoiceState, newState: VoiceState) => {
	const oldChannel = oldState.channel;
	const newChannel = newState.channel;

	//* Detects if the user joined the channel

	if (
		(oldChannel !== null || newChannel === null) &&
		(oldChannel === null ||
			newChannel === null ||
			oldChannel?.id === newChannel?.id)
	) {
		return;
	}

	const targetChannelId = newChannel.id;

	const guild = newState.guild;
};
