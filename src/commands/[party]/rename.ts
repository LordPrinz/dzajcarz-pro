import { getElements } from "@/helpers/redis/list";
import { ApplicationCommandOptionType } from "discord.js";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Renames party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	minArgs: 1,
	expectedArgs: "<name>",
	cooldowns: {
		duration: "2 m",
		type: "user",
		errorMessage: "You are renaming too fast! Please wait before renaming again.",
	},
	options: [
		{
			name: "name",
			description: "Name of the channel",
			required: true,
			type: ApplicationCommandOptionType.String,
		},
	],
	callback: async ({ args, guild, member }) => {
		if (!args.length) {
			return { content: "Please provide new channel name", ephemeral: true };
		}

		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to rename a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only rename party channels",
				ephemeral: true,
			};
		}

		try {
			await channel.setName(args[0]);
		} catch (err) {}

		return {
			content: `Channel name updated!`,
			ephemeral: true,
		};
	},
} as CommandObject;
