import { getElements } from "@/helpers/redis/set";
import { PartyAreaData } from "@/models/partyAreaModel";
import { sleep } from "@/utils";
import { type Message } from "discord.js";

export default async (message: Message) => {
	const partyData = await getElements<PartyAreaData[]>("partyAreas");

	const isCommandChannel = partyData.some(
		(party) => party.commandsChannel === message.channel.id
	);

	if (!isCommandChannel) return;

	await sleep(1000 * 16);

	if (message.deletable) {
		await message.delete();
	}
};
