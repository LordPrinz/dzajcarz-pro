import { ActionRow } from "@/components";
import { StringSelectMenu } from "@/components/select";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Test command to test modals",
	type: CommandType.BOTH,
	testOnly: true,
	ownerOnly: true,

	callback: async ({ interaction }) => {
		const selectMenu = StringSelectMenu({
			placeholder: "Select an option",
			id: "test_select",
			options: [
				{
					label: "Option 1",
					value: "option_1",
				},
				{
					label: "Option 2",
					value: "option_2",
				},
			],
		});

		const actionRow = ActionRow(selectMenu);

		const res = await interaction.reply({
			components: [actionRow],
		});

		const collector = res.createMessageComponentCollector({
			componentType: CommandType.StringSelect,
		});
	},
} as CommandObject;
