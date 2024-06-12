import { ActionRow } from "@/components";
import {
	StringSelectMenu,
	createStringSelectMenuCollector,
	type StringSelectOptions,
} from "@/components/select";
import { getCommands } from "@/utils/discord";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Help command, returns all possible for you commands",
	type: CommandType.BOTH,
	guildOnly: true,
	testOnly: true,
	callback: async ({ interaction }) => {
		const commands = getCommands();

		const keysArray = Array.from(commands.keys());

		const options: StringSelectOptions = keysArray.map((key) => {
			return {
				label: key,
				value: key,
			};
		});

		const select = StringSelectMenu({
			placeholder: "Select a command category",
			interaction,
			options,
		});

		const actionRow = ActionRow(select);

		const reply = await interaction.reply({
			components: [actionRow],
			ephemeral: true,
		});

		const collector = createStringSelectMenuCollector({
			interaction,
			reply,
			time: 1000 * 60 * 5,
		});

		collector.on("collect", (i) => {
			if (!i.values.length) return;

			const selectedCategory = i.values[0];

			const categoryCommands = commands.get(selectedCategory);

			console.log(categoryCommands);
		});
	},
} as CommandObject;
