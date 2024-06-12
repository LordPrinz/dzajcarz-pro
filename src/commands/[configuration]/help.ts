import { ActionRow, Embed } from "@/components";
import {
	StringSelectMenu,
	createStringSelectMenuCollector,
	type StringSelectOptions,
} from "@/components/select";
import { authorFooter } from "@/conf/bot";
import { filterCommandsByPermission, getCommands } from "@/utils/discord";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Help command, returns all possible for you commands",
	type: CommandType.BOTH,
	guildOnly: true,
	testOnly: true,
	callback: async ({ interaction, member, guild }) => {
		const commands = getCommands();

		const filteredCommands = filterCommandsByPermission(commands, member);

		const keysArray = Array.from(filteredCommands.keys());

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

		collector.on("collect", async (i) => {
			if (!i.values.length) return;

			const selectedCategory = i.values[0];

			const categoryCommands = filteredCommands.get(selectedCategory);

			const embed = Embed({
				title: `${selectedCategory} commands`,
				description: "List of all comands in this category",

				thumbnail: {
					url: guild.iconURL({ size: 512 }),
				},
				timestamp: new Date(),
				footer: {
					text: authorFooter,
				},

				fields: categoryCommands.map((command) => {
					return {
						name: command.name,
						value: command.description,
					};
				}),
			}).setColor("Random");

			await i.update({ embeds: [embed] });
		});
	},
} as CommandObject;
