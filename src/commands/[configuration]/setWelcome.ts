import { CommandType, type CommandObject } from "wokcommands";
import {
	ApplicationCommandOptionType,
	PermissionFlagsBits,
	type Channel,
} from "discord.js";

import { updateWelcomeChannel } from "@/db/welcomeChannel";
import { isTextChannel } from "@/validators/channel";

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

	callback: async ({ interaction, message, guild }) => {
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

		const dataToSave = {
			id: guild.id,
			channelId: targetChannel.id,
			content: messageContent,
		};

		const res = await updateWelcomeChannel(dataToSave);

		if (!res) {
			return {
				content: "Failed to set welcome channel",
			};
		}

		return {
			content: "Welcome channel set!",
		};
	},
} as CommandObject;
