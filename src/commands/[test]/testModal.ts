import { ActionRow } from "@/components";
import {
	StringSelectMenu,
	createStringSelectMenuCollector,
} from "@/components/select";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Test command to test modals",
	type: CommandType.BOTH,
	testOnly: true,
	ownerOnly: true,

	callback: async ({ interaction }) => {
		const selectMenu = StringSelectMenu({
			placeholder: "Select an option",
			interaction,

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

		const reply = await interaction.reply({
			components: [actionRow],
		});

		const collector = createStringSelectMenuCollector({
			reply,
			interaction,
			time: 60000,
		});

		collector.on("collect", (i) => {
			if (!i.values.length) return;

			i.reply(`You selected ${i.values.join(", ")}`);
		});
	},
} as CommandObject;
