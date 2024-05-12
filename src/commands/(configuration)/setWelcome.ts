import { isTextChannel } from "@/validators/channel";
import {
	ApplicationCommandOptionType,
	Channel,
	PermissionFlagsBits,
} from "discord.js";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Sets the welcome channel for the server.",
	type: CommandType.BOTH,

	permissions: [PermissionFlagsBits.Administrator],
	minArgs: 2,
	expectedArgs: "<channel> <message>",
	guildOnly: true,
	options: [
		{
			name: "channel",
			description: "The channel to send the welcome message in",
			required: true,
			type: ApplicationCommandOptionType.Channel,
		},
		{
			name: "message",
			description: "The message to send. Use @user to mention the user",

			required: true,
			type: ApplicationCommandOptionType.String,
		},
	],

	callback: async ({ interaction, message }) => {
		const targetChannel = message
			? message.mentions.channels.first()
			: interaction.options.getChannel("channel");

		if (!targetChannel || !isTextChannel(targetChannel as Channel)) {
			return {
				content: "Please tag a text channel",
			};
		}

		const messageContent = message
			? message.content.split(" ").slice(2).join(" ")
			: interaction.options.getString("message");

		return {
			content: "Welcome channel set!",
		};
	},
} as CommandObject;
