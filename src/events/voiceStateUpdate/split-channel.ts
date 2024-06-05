import { redisClient } from "@/lib/redisClient";
import { ChannelType, type CategoryChannel, type VoiceState } from "discord.js";

const PARTY_AREA_DATA = {
	guildId: "928638782952079391",
	categoryId: "1025861539565150290",
	splitChannelId: "1025861540592746517",
	newChannelName: "Party Area @",
	commandsChannelId: "1026133890995339315",
};

type PartyAreaInfo = {
	splitChannelId: string;
	newChannelName: string;
	commandsChannelId: string;
};

export default async (oldState: VoiceState, newState: VoiceState) => {
	const oldChannel = oldState.channel;
	const newChannel = newState.channel;

	// Detects if the user joined the channel

	if (
		(oldChannel !== null || newChannel === null) &&
		(oldChannel === null ||
			newChannel === null ||
			oldChannel?.id === newChannel?.id)
	) {
		return;
	}

	const targetChannelId = newChannel.id;

	const guild = newState.guild;
};
