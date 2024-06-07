import { type VoiceState } from "discord.js";
import { sleep } from "@/utils";

export default async (oldState: VoiceState, newState: VoiceState) => {
	const oldChannel = oldState.channel;
	const newChannel = newState.channel;

	//* Detects if the user left the channel

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
	const members = oldChannel.members.filter((member) => !member.user.bot);

	if (members.size > 0) {
		return;
	}

	//TODO: Check if the channel is not a proper channel to delete and return

	//* Delete if the channel is empty

	if (oldChannel.members.size === 0) {
		return await oldChannel.delete();
	}

	//* Delete after 1 minute if the channel has only bots

	await sleep(1000 * 60);

	const bots = oldChannel.members.filter((member) => member.user.bot);

	if (oldChannel.members.size === bots.size) {
		return await oldChannel.delete();
	}
};
