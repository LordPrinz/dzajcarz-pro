import { getElements } from "@/helpers/redis/list";
import { ApplicationCommandOptionType } from "discord.js";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Limits party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	minArgs: 1,
	expectedArgs: "<limit>",
	options: [
		{
			name: "limit",
			description: "The new channel limit",
			required: true,
			type: ApplicationCommandOptionType.Integer,
			maxValue: 99,
			minValue: 1,
		},
	],
	callback: async ({ args, member }) => {
		if (!args.length) {
			return { content: "Please provide a new limit", ephemeral: true };
		}

		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to limit a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only limit party channels",
				ephemeral: true,
			};
		}

		const limit = parseInt(args[0]);

		if (limit < 1 || limit > 99) {
			return {
				content: "Limit must be between 1 and 99",
				ephemeral: true,
			};
		}

		try {
			await channel.edit({
				userLimit: limit,
			});
		} catch (err) {}

		return {
			content: `Channel limit updated!`,
			ephemeral: true,
		};
	},
} as CommandObject;
