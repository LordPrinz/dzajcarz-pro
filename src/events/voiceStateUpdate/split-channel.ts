import { appendElement } from "@/helpers/redis/list";
import { getElements } from "@/helpers/redis/set";
import { PartyAreaData } from "@/models/partyAreaModel";
import { replaceTagToUser } from "@/utils";
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

	const guildId = newChannel.guild.id;

	const partyAreas = await getElements<PartyAreaData[]>("partyAreas");

	const desiredParty = partyAreas.find(
		(area) => area.guildId === guildId && area.splitChannelId === targetChannelId
	); // It finds the desired party area by splitChannelId, it works that if the splitChannel with certain id exists and was clicked, it will return the desired party area

	if (!desiredParty) {
		return;
	}

	const user = newState.member;

	const userName = user.nickname || user.user.username;

	const newChannelName = replaceTagToUser(desiredParty.newChannelName, userName);

	const customChannel = await newChannel.clone({
		name: newChannelName,
	});

	await user.voice.setChannel(customChannel);
	await appendElement("customChannels", customChannel.id);
};
