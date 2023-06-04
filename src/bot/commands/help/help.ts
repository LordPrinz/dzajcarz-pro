import { Client, MessageEmbed, MessageSelectOptionData } from "discord.js";
import { ICommand } from "wokcommands";
import generateSelection from "../../../utils/commands/generateSelection";
import Command from "../../../types/TCommand";
import { capitalizeFirstLetter } from "../../../utils/oneLiners";
import { getCommands } from "../../../utils/getData";

let guildCommands: Command[];

const help = {
	category: "help",
	description: "Help command",
	slash: "both",

	init: (client: Client) => {
		client.on("interactionCreate", (interaction) => {
			if (!interaction.isSelectMenu()) {
				return;
			}

			const { customId, member, guild } = interaction;

			const value = interaction.values[0];

			if (!value) {
				interaction.reply("Please select a command category.");
				return;
			}

			if (customId !== "help") {
				return;
			}

			if (!guildCommands) {
				return;
			}

			const selectedCommands: Command[] = [];

			const filteredCommands: Command[] = [];

			guildCommands.map((command) => {
				if (command.category.toLowerCase() === value.toLowerCase()) {
					selectedCommands.push(command);
				}
			});

			const specialCommands: string[] = ["createparty", "deleteparty"];

			selectedCommands.map((command) => {
				if (typeof member?.permissions === "string") {
					return;
				}
				if (!member!.permissions.has("MANAGE_CHANNELS")) {
					if (specialCommands.includes(command.names[0].toLowerCase())) {
						return;
					}
				}
				if (command.hidden) {
					return;
				}

				filteredCommands.push(command);
			});

			const fields: any[] = [];

			filteredCommands.map((command) => {
				const filed = {
					name: command.names.join(`, `),
					value: `${command.description}\n ${
						command.syntax && `Syntax: ${command.syntax}`
					}`,
				};
				fields.push(filed);
			});

			const embed = new MessageEmbed()
				.setColor("RANDOM")
				.setTitle(`${capitalizeFirstLetter(value)} Commands`)
				.setThumbnail(guild!.iconURL({ size: 2048, dynamic: true })!)
				.setTimestamp()
				.addFields(fields)
				.setTitle("Most commands support slash and legacy syntax.")
				.setFooter({
					text: `${process.env.AUTHOR! || ":)"}`,
					iconURL: guild!.iconURL({ size: 2048, dynamic: true })!,
				});

			interaction.reply({
				embeds: [embed],
				ephemeral: true,
			});
		});
	},

	callback: async ({ channel, instance, member, interaction }) => {
		if (!channel) {
			return;
		}

		const message = await channel.send({
			content: "Select type of commands to display:",
		});

		const commands = getCommands(instance);

		guildCommands = [...commands];

		const categories: string[] = [];

		commands.map((command: Command) => {
			const commandCategory = command.category.toLowerCase();

			if (categories.includes(commandCategory)) {
				return;
			}

			categories.push(commandCategory);
		});

		const userPermissions = member.permissions;

		const filteredCategories: string[] = [];

		categories.map((category: string) => {
			if (category === "moderation" || category === "configuration") {
				if (!userPermissions.has("ADMINISTRATOR")) {
					return;
				}
			}

			if (category === "musicoffline") {
				return;
			}

			if (category === "testing") {
				return;
			}

			if (category === "help") {
				return;
			}

			filteredCategories.push(category);
		});

		const options: MessageSelectOptionData[] = [];

		filteredCategories.map((category: string) => {
			options.push({
				label: capitalizeFirstLetter(category),
				value: category,
			});
		});

		const menu = generateSelection(message, options);

		message.edit({
			components: [menu],
		});

		if (interaction) {
			interaction.reply("There you are!");
		}
	},
} as ICommand;

export default help;
