import { getPartyAreas } from "@/db/partyArea";
import { type PartyAreaData } from "@/models/partyAreaModel";
import { getAllVoiceChannels } from "@/utils";
import { VoiceChannel, type Client } from "discord.js";
import { deleteElements, getElements, setElements } from "./set";
import { appendElement } from "./list";

export const syncVCRedis = async (client: Client) => {
	const partyAreas = await getElements<PartyAreaData[]>("partyAreas");

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

	await deleteElements("customChannels");

	for (const channel of voiceChannelsToSave) {
		await appendElement("customChannels", channel.id);
	}
};

export const syncPartyRedisMongo = async () => {
	const partyArea = await getPartyAreas();

	await setElements("partyAreas", partyArea);
};
