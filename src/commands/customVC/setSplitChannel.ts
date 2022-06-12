import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";

const setSplitChannel = {
	category: "Party",
	description: "Set the new split channel",
	permissions: ["MANAGE_CHANNELS"],
	slash: "both",
	testOnly: true,
	minArgs: 2,
	options: [
		{
			name: "channel",
			description: "The channel you want to be split channel.",
			type: "CHANNEL",
			required: true,
		},
		{
			name: "category",
			description: "The category.",
			type: "CHANNEL",
			required: true,
		},
	],
	expectedArgs: "<channel> <category> ",

	callback: async ({ guild, args }) => {
		if (!guild) {
			return "You can't use this command outside of a guild.";
		}
		if (!args) {
			return "You have to pass a channel.";
		}

		const channelId = args[0];
		const categoryId = args[1];

		const channel = guild.channels.cache.find((c) => c.id === channelId);
		const category = guild.channels.cache.find((c) => c.id === categoryId);

		if (channel?.type !== "GUILD_VOICE") {
			return "You can only select voice channel.";
		}

		if (category?.type !== "GUILD_CATEGORY") {
			return "You can only pass a category.";
		}

		const results = await partyAreaSchema.findOneAndUpdate(
			{
				groupId: category.id,
			},
			{
				splitChannelId: channel.id,
			},
			{
				upsert: true,
			}
		);

		if (!results) {
			return "Something went wrong!";
		}

		channel.edit({
			parent: category,
		});

		return "Channel set!";
	},
} as ICommand;

export default setSplitChannel;
