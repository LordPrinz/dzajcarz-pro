import { ICommand } from "wokcommands";

const limit = {
	category: "Party",
	description: "Limits channel capacity.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<limit>",
	options: [
		{
			name: "limit",
			description: "The limits of users allowed to join the channel.",
			type: "NUMBER",
			required: true,
		},
	],

	callback: async ({ args, guild, member }) => {
		if (!guild) {
			return {
				custom: true,
				content: "Can not use this command outside of guild!",
				ephemeral: true,
			};
		}

		if (!args) {
			return {
				custom: true,
				content: "You have to pass the channel limit!",
				ephemeral: true,
			};
		}

		if (!member?.voice.channel) {
			return {
				custom: true,
				content: "Can not use this command outside of the voice channel!",
				ephemeral: true,
			};
		}
		const limit = +args[0];

		if (!limit) {
			return "You have to pass the channel limit!";
		}

		if (limit < 1) {
			return "You can not pass number lower than 1!";
		}

		if (limit > 99) {
			return "You can not pass number greater than 99!";
		}

		if (isNaN(limit)) {
			return "You can only pass positive values!";
		}

		const channel = member.voice.channel;

		channel.edit({
			userLimit: limit,
		});

		try {
			return "Limit set!";
		} catch (error) {
			console.log(error);
		}
	},
} as ICommand;

export default limit;
