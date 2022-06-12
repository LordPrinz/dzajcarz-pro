import { Guild, MessageEmbed, TextChannel } from "discord.js";
import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import PartyArea from "../../types/PartyArea";
import { getCommands } from "../../utilities/discord/get";

const updateHelp = {
	category: "Party",
	description: "Updates the command's help channel information.",
	hidden: true,
	ownerOnly: true,
	slash: "both",
	testOnly: true,

	callback: async ({ client, instance }) => {
		const partyData: PartyArea[] = await partyAreaSchema.find({});

		if (!partyData.length) {
			return {
				custom: true,
				ephemeral: true,
				content: "No data found.",
			};
		}

		const guilds: Guild[] = [];

		partyData.map((data) => {
			client.guilds.cache.map((guild) => {
				if (guild.id === data.guildId) {
					guilds.push(guild);
				}
			});
		});

		const commandsChannels: TextChannel[] = [];
		guilds.map((guild) => {
			partyData.map((data) => {
				const commandChannel = guild.channels.cache.find(
					(channel) => channel.id === data.commandsChannel
				);
				if (!commandChannel) {
					return;
				}
				if (commandChannel.type !== "GUILD_TEXT") {
					return;
				}

				commandsChannels.push(commandChannel);
			});
		});

		commandsChannels.map(async (channel) => {
			const messages = await channel.messages.fetch();

			const firstMessage = messages.first();

			const guild = channel.guild;
			const adminCommands = [
				"createparty",
				"deleteparty",
				"setsplitchannel",
				"setcommandchannel",
			];

			const commands = getCommands(instance)
				.filter((command) => command.category.toLowerCase() === "party")
				.filter((command) => !adminCommands.includes(command.names[0].toLowerCase()))
				.filter((command) => !command.hidden);

			const fields: any[] = [];

			commands.map((command) => {
				console.log(command);
				const filed = {
					name: command.names.join(`, `),
					value: `${command.description}\n ${
						command.syntax && `Syntax: ${command.syntax}`
					}`,
				};
				fields.push(filed);
			});

			if (!firstMessage) {
				const embed = new MessageEmbed()
					.setColor("AQUA")
					.setTitle("Party channels commands:")
					.setDescription("Slash and legacy commands are supported!")
					.setThumbnail(guild!.iconURL({ size: 2048, dynamic: true })!)
					.setTimestamp()
					.addFields(fields)
					.setFooter({
						text: `${process.env.AUTHOR! || ":)"}`,
						iconURL: guild.iconURL({ size: 2048, dynamic: true })!,
					});

				channel.send({ embeds: [embed] });
				console.log("a");
				return;
			}

			if (!firstMessage.editable) {
				return;
			}

			const embed = new MessageEmbed()
				.setColor("AQUA")
				.setTitle("Party channels commands:")
				.setDescription("Slash and legacy commands are supported!")
				.setThumbnail(guild!.iconURL({ size: 2048, dynamic: true })!)
				.setTimestamp()
				.addFields(fields)
				.setFooter({
					text: `${process.env.AUTHOR! || ":)"}`,
					iconURL: guild.iconURL({ size: 2048, dynamic: true })!,
				});

			firstMessage.edit({ embeds: [embed] });
		});

		try {
			return {
				custom: true,
				ephemeral: true,
				content: "Done!",
			};
		} catch (error) {
			console.log(error);
		}
	},
} as ICommand;

export default updateHelp;
