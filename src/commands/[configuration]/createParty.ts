import { ActionRow, TextInput } from "@/components";
import {
	ActionRowBuilder,
	Message,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Replies with pong",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,
	testOnly: true,

	callback: async ({ message, channel, interaction }) => {
		const customModalId = "interaction--create_party_area";

		const filter = (interaction: any) => interaction.customId === customModalId;

		const nameInput = TextInput({
			customId: "name",
			label: "Channel name",
			style: TextInputStyle.Short,
			required: true,
			minLength: 2,
			maxLength: 50,
		});

		const modal = new ModalBuilder({
			customId: customModalId,
			title: "Create a party area",
		});

		// Ensure the ActionRowBuilder is correctly typed
		const actionRow = ActionRow(nameInput);

		modal.addComponents(actionRow);

		await interaction.showModal(modal);

		interaction
			.awaitModalSubmit({ filter, time: 30000 })
			.then((modalInteraction) => {
				const name = modalInteraction.fields.getTextInputValue("name");

				modalInteraction.reply("Party area created!");
			});
	},
} as CommandObject;
