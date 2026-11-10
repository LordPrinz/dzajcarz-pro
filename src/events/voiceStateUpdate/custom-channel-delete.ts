import { VoiceBasedChannel, type VoiceState } from "discord.js";
import { sleep } from "@/utils";
import { checkElementExists, deleteElement } from "@/helpers/redis/list";

const handleChannelDelete = async (
	oldChannel: VoiceBasedChannel,
	channelId: string
) => {
	await deleteElement("customChannels", channelId);
	return await oldChannel.delete();
};

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

	const shouldBeDeleted = await checkElementExists(
		"customChannels",
		targetChannelId
	);

	if (!shouldBeDeleted) {
		return;
	}

	if (oldChannel.members.size === 0) {
		return await handleChannelDelete(oldChannel, targetChannelId);
	}

	//* Delete after 1 minute if the channel has only bots

	await sleep(1000 * 60);

	const bots = oldChannel.members.filter((member) => member.user.bot);

	if (oldChannel.members.size === bots.size) {
		await handleChannelDelete(oldChannel, targetChannelId);
	}
};
