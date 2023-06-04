import { ICommand } from "wokcommands";

const invite = {
	category: "Party",
	description: "Invites user to the party channel.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<user>",
	options: [
		{
			name: "user",
			description: "The user you want to invite.",
			type: "MENTIONABLE",
			required: true,
		},
		{
			name: "message",
			description: "The message you want to send in to invite content.",
			type: "STRING",
			required: false,
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

		const message = `<@!${member.user.id}> invites you to his voice channel! ${
			args[1] ? `\n"${args[1]}"` : ""
		} `;

		const channel = member.voice.channel;

		const invite = await guild.invites
			.create(channel, {
				temporary: true,
				unique: true,
				maxUses: 1,
			})
			.catch(() => {});

		if (!invite) {
			return {
				custom: true,
				content: "Could not generate invite!",
				ephemeral: true,
			};
		}

		if (!("send" in member)) {
			return {
				custom: true,
				content: "Something went wrong!",
				ephemeral: true,
			};
		}

		const sentMessage = await targetUser.user
			.send(`${message} \n https://discord.gg/${invite.code}`)
			.catch(() => {});

		channel.permissionOverwrites.edit(targetUser.id, {
			CONNECT: true,
		});

		if (!sentMessage) {
			return {
				custom: true,
				content: "Could not send message!",
				ephemeral: true,
			};
		}

		return {
			custom: true,
			content: "Invite sent!",
			ephemeral: true,
		};
	},
} as ICommand;

export default invite;
