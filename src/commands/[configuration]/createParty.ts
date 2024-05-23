import { ActionRow, Modal, TextInput } from "@/components";
import { getTextInputValue } from "@/components/TextInput";
import { PermissionFlagsBits } from "discord.js";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Creates a party area category and channels.",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,

	callback: async ({ interaction }) => {
		const categoryNameInput = TextInput({
			customId: "categoryName",
			label: "Party area name",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 45,
		});

		const categoryNameInputComponent = ActionRow(categoryNameInput);

		const splitChannelNameInput = TextInput({
			customId: "splitChannelName",
			label: "Split channel name",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 50,
		});

		const splitChannelNameInputComponent = ActionRow(splitChannelNameInput);

		const newChannelNameInput = TextInput({
			customId: "newChannelName",
			label: "New channel name (use @ to mention user)",
			style: "short",
			required: true,
			minLength: 1,
			maxLength: 50,
		});

		const newChannelNameInputComponent = ActionRow(newChannelNameInput);

		const commandChannelNameInput = TextInput({
			customId: "commandChannelName",
			label: "Message auto delete after 15 seconds channel",
			style: "short",
			required: false,
			minLength: 1,
			maxLength: 50,
		});

		const commandChannelNameInputComponent = ActionRow(commandChannelNameInput);

		const { modal, filter } = Modal({
			title: "Create a party area",
			components: [
				categoryNameInputComponent,
				splitChannelNameInputComponent,
				newChannelNameInputComponent,
				commandChannelNameInputComponent,
			],
		});

		await interaction.showModal(modal);

		const modalInteraction = await interaction
			.awaitModalSubmit({
				filter,
				time: 1000 * 60 * 3,
			})
			.catch(() => null);

		if (!modalInteraction) {
			return;
		}

		const categoryName = getTextInputValue(modalInteraction, "categoryName");
		const splitChannelName = getTextInputValue(
			modalInteraction,
			"splitChannelName"
		);
		const newChannelName = getTextInputValue(modalInteraction, "newChannelName");
		const commandChannelName = getTextInputValue(
			modalInteraction,
			"commandChannelName"
		);

		console.log(
			categoryName,
			splitChannelName,
			newChannelName,
			commandChannelName
		);
		modalInteraction.reply("Party area created!");
	},
} as CommandObject;
