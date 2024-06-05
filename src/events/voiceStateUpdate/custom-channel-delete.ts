import { type VoiceState } from "discord.js";

export default async (oldState: VoiceState, newState: VoiceState) => {
	const oldChannel = oldState.channel;
	const newChannel = newState.channel;

	// Detects if the user left the channel

	if (
		(oldChannel === null ||
			newChannel !== null ||
			oldChannel?.id === newChannel?.id) &&
		(oldChannel === null ||
			newChannel === null ||
			oldChannel?.id === newChannel?.id)
	) {
		return;
	}

	const targetChannelId = oldChannel.id;
};
