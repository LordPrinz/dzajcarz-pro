import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import PartyArea from "../../types/PartyArea";

const cooldownChannels: string[] = [];
const cooldownsTime: number[] = [];

const isCooldown = (id: string) => {
	return cooldownChannels.includes(id);
};

const setChannel = {
	category: "Party",
	description:
		"Renames the voice channel. You can only rename voice channel once per 10 minutes.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<name>",

	options: [
		{
			name: "name",
			required: true,
			description: "Name of the VC",
			type: "STRING",
		},
	],

	callback: async ({ args, guild, member }) => {
		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}
		const channelId = member!.voice.channelId;
		const newName = args[0].replace(
			/@/g,
			`${member?.nickname || member?.user.username}`
		);
		const voiceChannel = [
			...guild!.channels.cache.filter((channel) => channel.id === channelId),
		][0][1];

		const voiceChannelParentId = voiceChannel.parentId;

		if (!isCooldown(voiceChannel.id)) {
			const timeout = setTimeout(() => {
				cooldownChannels.shift();
			}, 1000 * 10 * 60);
		}

		if (isCooldown(voiceChannel.id)) {
			const index = cooldownChannels.indexOf(voiceChannel.id);
			const message =
				cooldownsTime[index] > 1
					? `You have cooldown lol. Wait ${cooldownsTime[index]} minutes.`
					: `You have cooldown lol. Wait ${cooldownsTime[index]} minute.`;
			return message;
		}

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
			return "You can't rename channel outside party area!";
		}

		partyData.map((data) => {
			if (data.splitChannelId === voiceChannel?.id) {
				return "You can't rename this channel!";
			}
		});

		await voiceChannel.setName(newName);
		cooldownChannels.push(voiceChannel.id);

		const index = cooldownChannels.indexOf(voiceChannel.id);
		cooldownsTime[index] = 10;

		const interval = setInterval(() => {
			cooldownsTime[index]--;
		}, 1000 * 60);

		return "Channel name updated!";
	},
} as ICommand;

export default setChannel;
