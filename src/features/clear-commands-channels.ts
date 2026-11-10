import { getElements } from "@/helpers/redis/set";
import { PartyAreaData } from "@/models/partyAreaModel";
import { Client, TextChannel } from "discord.js";
import WOK from "wokcommands";

export default async (_: WOK, client: Client) => {
	const partyData = await getElements<PartyAreaData[]>("partyAreas");

	for (const { commandsChannel: commandsChannelId } of partyData) {
		const commandsChannel = (await client.channels.fetch(
			commandsChannelId
		)) as TextChannel;

		if (!commandsChannel) {
			console.error(`Channel with id ${commandsChannelId} not found`);
			continue;
		}

		const messages = await commandsChannel.messages.fetch();

		for (const [, message] of messages) {
			if (message.deletable) {
				await message.delete();
			}
		}
	}
};
