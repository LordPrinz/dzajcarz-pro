import { MessageEmbed, TextChannel } from "discord.js";
import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import { getCommands } from "../../utilities/discord/get";

const sendInfoToCommandChannel = async (
	channel: TextChannel,
	commands: any[]
) => {
	const guild = channel.guild;

	const fields: any[] = [];

	commands.map((command) => {
		const filed = {
			name: command.names.join(`, `),
			value: `${command.description}\n ${
				command.syntax && `Syntax: ${command.syntax}`
			}`,
		};
		fields.push(filed);
	});

	const embedMessage = new MessageEmbed()
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

	channel.send({ embeds: [embedMessage] });
};

const setCommandChannel = {
	category: "Party",
	description: "Set the new command channel",
	permissions: ["MANAGE_CHANNELS"],
	slash: "both",
	minArgs: 2,
	options: [
		{
			name: "channel",
			description: "The channel you want to be command channel.",
			type: "CHANNEL",
			required: true,
		},
		{
			name: "category",
			description: "The category.",
			type: "CHANNEL",
			required: true,
		},
	],
	expectedArgs: "<channel> <category> ",

	callback: async ({ guild, args, instance }) => {
		if (!guild) {
			return "You can't use this command outside of a guild.";
		}
		if (!args) {
			return "You have to pass a channel.";
		}

		const channelId = args[0];
		const categoryId = args[1];

		const channel = guild.channels.cache.find((c) => c.id === channelId);
		const category = guild.channels.cache.find((c) => c.id === categoryId);

		if (channel?.type !== "GUILD_TEXT") {
			return "You can only select a text channel.";
		}

		if (category?.type !== "GUILD_CATEGORY") {
			return "You can only pass a category.";
		}

		const newChannel = await channel.clone().catch(() => {});

		if (!newChannel) {
			return "Something went wrong!";
		}

		channel.delete().catch(() => {});

		const results = await partyAreaSchema.findOneAndUpdate(
			{
				groupId: category.id,
			},
			{
				commandsChannel: newChannel.id,
			},
			{
				upsert: true,
			}
		);

		if (!results) {
			return "Something went wrong!";
		}

		newChannel.edit({
			parent: category,
		});

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

		sendInfoToCommandChannel(newChannel, commands);

		return "Channel set!";
	},
} as ICommand;

export default setCommandChannel;
