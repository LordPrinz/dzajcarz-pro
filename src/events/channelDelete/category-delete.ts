import { deletePartyArea } from "@/db/partyArea";
import { getElements, setElements } from "@/helpers/redis/set";
import { PartyAreaData } from "@/models/partyAreaModel";
import { ChannelType, type Channel } from "discord.js";

export default async (channel: Channel) => {
	if (channel.type !== ChannelType.GuildCategory) {
		return;
	}

	const partyAreas = await getElements<PartyAreaData[]>("partyAreas");

	const channelIdToDelete = channel.id;

	const filteredPartyAreas = partyAreas.filter(
		(el) => el.id !== channelIdToDelete
	);

	if (filteredPartyAreas.length === partyAreas.length) {
		return;
	}

	await setElements("partyAreas", filteredPartyAreas);
	await deletePartyArea(channelIdToDelete);
};
