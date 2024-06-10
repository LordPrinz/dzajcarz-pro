import { getPartyAreas } from "@/db/partyArea";
import { redisClient } from "@/lib/redisClient";
import { type PartyAreaData } from "@/models/partyAreaModel";
import { getAllVoiceChannels } from "@/utils";
import { VoiceChannel, type Client } from "discord.js";

export const syncVCRedis = async (client: Client) => {
	const partyAreas = JSON.parse(
		await redisClient.get("partyArea")
	) as PartyAreaData[];

	const splitChannelIds = [];
	const partyAreasIds = [];

	for (const partyArea of partyAreas) {
		splitChannelIds.push(partyArea.splitChannelId);
		partyAreasIds.push(partyArea.id);
	}

	const deleteFilter = (channel: VoiceChannel) => {
		const isSplitChannel = !splitChannelIds.includes(channel.id);

		const bots = channel.members.filter((member) => member.user.bot).size;

		const isOccupied =
			channel.members.size === 0 || channel.members.size === bots;

		const partyCategoryChildren = partyAreasIds.includes(channel.parentId);

		return isSplitChannel && isOccupied && partyCategoryChildren;
	};

	const voiceChannelsToDelete = await getAllVoiceChannels(client, deleteFilter);

	voiceChannelsToDelete.forEach((channel) => {
		channel.delete();
	});

	const saveFilter = (channel: VoiceChannel) => {
		const isSplitChannel = !splitChannelIds.includes(channel.id);

		const bots = channel.members.filter((member) => member.user.bot).size;

		const isOccupied = channel.members.size > bots;

		const partyCategoryChildren = partyAreasIds.includes(channel.parentId);

		return isSplitChannel && isOccupied && partyCategoryChildren;
	};

	const voiceChannelsToSave = await getAllVoiceChannels(client, saveFilter);

	await redisClient.del("customChannels");

	for (const channel of voiceChannelsToSave) {
		await redisClient.rPush("customChannels", channel.id);
	}
};

export const syncPartyRedisMongo = async () => {
	const partyArea = await getPartyAreas();

	await redisClient.set("partyArea", JSON.stringify(partyArea));
};
