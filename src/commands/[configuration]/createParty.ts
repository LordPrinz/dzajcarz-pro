import { ActionRow, Modal, TextInput } from "@/components";
import { getTextInputValue } from "@/components/TextInput";
import { PermissionFlagsBits, TextInputStyle } from "discord.js";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Creates a party area category and channels.",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,
	testOnly: true,

	callback: async ({ interaction }) => {
		const categoryNameInput = TextInput({
			customId: "categoryName",
			label: "Party area name",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 50,
		});

		const splitChannelNameInput = TextInput({
			customId: "splitChannelName",
			label: "Split channel name",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 50,
		});

		const newChannelNameInput = TextInput({
			customId: "newChannelName",
			label:
				"New channel name (use @ to mention the user who created the channel)",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 50,
		});

		const commandChannelNameInput = TextInput({
			customId: "commandChannelName",
			label:
				"Command channel name (channel where users can use commands and is cleared every 20 seconds)",
			style: "short",
			required: false,
			minLength: 1,
			maxLength: 50,
		});

		const actionRow = ActionRow(
			categoryNameInput,
			splitChannelNameInput,
			newChannelNameInput,
			commandChannelNameInput
		);

		const { modal, filter } = Modal({
			title: "Create a party area",
			components: [actionRow],
		});

		await interaction.showModal(modal);

		const modalInteraction = await interaction.awaitModalSubmit({
			filter,
			time: 30_000,
		});

		const name = getTextInputValue(modalInteraction, "name");
		const splitChannelName = getTextInputValue(
			modalInteraction,
			"splitChannelName"
		);
		const newChannelName = getTextInputValue(modalInteraction, "newChannelName");
		const commandChannelName = getTextInputValue(
			modalInteraction,
			"commandChannelName"
		);

		console.log(name, splitChannelName, newChannelName, commandChannelName);
		modalInteraction.reply("Party area created!");
	},
} as CommandObject;
