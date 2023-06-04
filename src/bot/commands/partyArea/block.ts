import { ICommand } from "wokcommands";

const block = {
	category: "Party",
	description: "Blocks user from your party channel.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<user>",
	options: [
		{
			name: "user",
			description: "The user you want to block.",
			type: "MENTIONABLE",
			required: true,
		},
	],

	callback: ({ args, guild, member }) => {
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
				content: "You have to pass the user!",
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

		const targetUser = guild.members.cache.find(
			(user) => user.id === args[0].replace("<@!", "").replace(">", "")
		);

		if (!targetUser) {
			return {
				custom: true,
				content: "You have to pass the user!",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		channel.permissionOverwrites.edit(targetUser, {
			CONNECT: false,
		});

		return {
			custom: true,
			content: "User blocked from your party channel.",
			ephemeral: true,
		};
	},
} as ICommand;

export default block;
