import { CategoryChannel, Guild, MessageEmbed, TextChannel } from "discord.js";
import { ICommand } from "wokcommands";
import partyAreaSchema from "../../models/party-area-schema";
import { getCommands } from "../../../utils/getData";

const createChannelCategory = async (
	guild: Guild,
	name: string
): Promise<CategoryChannel> => {
	const category = await guild.channels.create(name, {
		type: "GUILD_CATEGORY",
	});
	return category;
};

const createSplitChannel = async (category: CategoryChannel, name: string) => {
	const splitChannel = await category.guild.channels.create(name, {
		type: "GUILD_VOICE",
	});
	splitChannel.setParent(category.id);
	return splitChannel;
};

const createCommandChannel = async (
	category: CategoryChannel,
	name: string
) => {
	const commandChannel = await category.guild.channels.create(name, {
		type: "GUILD_TEXT",
	});
	commandChannel.setParent(category.id);
	return commandChannel;
};

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

const createParty = {
	category: "Party",
	description: "Setups the group.",
	slash: "both",
	minArgs: 3,

	permissions: ["MANAGE_CHANNELS"],

	expectedArgs:
		"<group_name> <channel_name> <new_channel_name> <commands_channel_name>",
	expectedArgsTypes: ["STRING", "STRING", "STRING", "STRING"],
	options: [
		{
			name: "group_name",
			description: "Name of channels group.",
			type: "STRING",
			required: true,
		},
		{
			name: "channel_name",
			description: "Name of the split channel.",
			type: "STRING",
			required: true,
		},
		{
			name: "new_channel_name",
			description: "Name of the created channel.",
			type: "STRING",
			required: true,
		},
		{
			name: "commands_channel_name",
			description: "Name of the commands channel. *OPTIONAL*",
			type: "STRING",
			required: false,
		},
	],
	callback: async ({ args, guild, instance }) => {
		const groupName = args[0] || "Party";
		const splitChannelName = args[1] || "Split channel";
		const newChannelName = args[2] || "@ channel";
		const commandsChannelName = args[3];

		if (!guild) {
			return "You can not use this command outside of the guild.";
		}
		const category = await createChannelCategory(guild, groupName);
		const splitChannel = await createSplitChannel(category, splitChannelName);
		let commandsChannel: TextChannel;

		if (commandsChannelName) {
			commandsChannel = await createCommandChannel(
				category,
				commandsChannelName
			);

			const adminCommands = [
				"createparty",
				"deleteparty",
				"setsplitchannel",
				"setcommandchannel",
			];

			const commands = getCommands(instance)
				.filter((command) => command.category.toLowerCase() === "party")
				.filter(
					(command) => !adminCommands.includes(command.names[0].toLowerCase())
				)
				.filter((command) => !command.hidden);

			sendInfoToCommandChannel(commandsChannel, commands);
		}

		await partyAreaSchema.insertMany([
			{
				guildId: guild.id,
				groupId: category.id,
				splitChannelId: splitChannel.id,
				newChannelName,
				commandsChannel: commandsChannel!?.id,
			},
		]);

		return "Party area is ready!";
	},
} as ICommand;

export default createParty;
