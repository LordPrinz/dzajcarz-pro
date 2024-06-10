import { type VoiceState } from "discord.js";
import { sleep } from "@/utils";
import { redisClient } from "@/lib/redisClient";

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

	const script = `
	local channelId = ARGV[1]
	local list = redis.call('LRANGE', KEYS[1], 0, -1)
	for _, v in ipairs(list) do
			if v == channelId then
					return 1
			end
	end
	return 0
`;

	const shouldBeDeleted = await redisClient.eval(script, {
		keys: ["customChannels"],
		arguments: [targetChannelId],
	});

	if (!shouldBeDeleted) {
		return;
	}

	if (oldChannel.members.size === 0) {
		await redisClient.lRem("customChannels", 0, targetChannelId);
		return await oldChannel.delete();
	}

	//* Delete after 1 minute if the channel has only bots

	await sleep(1000 * 60);

	const bots = oldChannel.members.filter((member) => member.user.bot);

	if (oldChannel.members.size === bots.size) {
		await redisClient.lRem("customChannels", 0, targetChannelId);
		return await oldChannel.delete();
	}
};
