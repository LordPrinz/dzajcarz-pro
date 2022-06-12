import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import PartyArea from "../../types/PartyArea";

const lock = {
	category: "Party",
	description: "Locks the voice channel for other members.",
	slash: "both",

	callback: async ({ guild, member }) => {
		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}
		const channelId = member!.voice.channelId;

		const voiceChannel: any = [
			...guild!.channels.cache.filter((channel) => channel.id === channelId),
		][0][1];

		const voiceChannelParentId = voiceChannel.parentId;

		let partyData: PartyArea[];

		if (!partyData!) {
			const results = await partyAreaSchema.find({ guildId: guild!.id });

			if (!results) {
				return;
			}

			partyData = results;
		}

		const isChannelInPartyArea = partyData.map((data) => {
			return data.groupId === voiceChannelParentId;
		});

		if (!isChannelInPartyArea.includes(true)) {
			return "You can't lock channel outside party area!";
		}

		partyData.map((data) => {
			if (data.splitChannelId === voiceChannel?.id) {
				return "You can't lock this channel!";
			}
		});

		const roleId = guild?.roles.everyone.id;

		voiceChannel?.permissionOverwrites.edit(roleId!, {
			CONNECT: false,
		});

		return "Channel locked!";
	},
} as ICommand;

export default lock;
