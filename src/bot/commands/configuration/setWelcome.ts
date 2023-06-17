import { ICommand } from "wokcommands";
import welcomeSchema from "../../models/welcomeModel";

const setWelcome = {
	category: "Configuration",
	description: "Sets the welcome channel.",

	permissions: ["ADMINISTRATOR"],

	minArgs: 2,
	expectedArgs: "<channel> <text>",

	slash: "both",

	options: [
		{
			name: "channel",
			description: "The target channel.",
			required: true,
			type: "CHANNEL",
		},
		{
			name: "text",
			description: "The welcome message.",
			required: true,
			type: "STRING",
		},
	],

	callback: async ({ guild, message, interaction, args }) => {
		if (!guild) return "Please use this command within a server.";

		const target = message
			? message.mentions.channels.first()
			: interaction.options.getChannel("channel");

		if (!target || target.type !== "GUILD_TEXT") {
			return "Please tag a text channel.";
		}

		let text = interaction?.options.getString("text");

		if (message) {
			args.shift();
			text = args.join(" ");
		}

		await welcomeSchema.findOneAndUpdate(
			{
				_id: guild.id,
			},
			{
				_id: guild.id,
				text,
				channelId: target.id,
			},
			{
				upsert: true,
			}
		);

		return "Welcome channel set!";
	},
} as ICommand;

export default setWelcome;
