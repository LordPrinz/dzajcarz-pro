import { ApplicationCommandOptionType, GuildMember } from "discord.js";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Invite a user to your party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	minArgs: 1,
	expectedArgs: "<user> <message>",
	deferReply: true,
	options: [
		{
			name: "user",
			description: "User to invite",
			required: true,
			type: ApplicationCommandOptionType.Mentionable,
		},
		{
			name: "message",
			description: "Message to send to the user",
			required: false,
			type: ApplicationCommandOptionType.String,
		},
	],
	callback: async ({ args, guild, member }) => {
		if (!args.length) {
			return { content: "Please mention a user to invite", ephemeral: true };
		}

		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to invite a user",
				ephemeral: true,
			};
		}

		const user = (await guild.members.fetch({
			user: args[0],
		})) as GuildMember;

		if (!user) {
			return {
				content: "User not found",
				ephemeral: true,
			};
		}

		const inviteMessage = `<@${
			user.id
		}>, you have been invited to join ${member}'s party channel!
			${args[1] ? `\n${args[1]}` : ""}`;

		const channel = member.voice.channel;

		const invite = await guild.invites.create(channel, {
			temporary: true,
			unique: true,
			maxUses: 1,
		});

		if (!invite) {
			return {
				content: "Failed to create invite",
				ephemeral: true,
			};
		}

		channel.permissionOverwrites.edit(user, {
			Connect: true,
		});

		try {
			await user.user.send(`${inviteMessage}\n${invite.url}`);
		} catch (err) {
			return {
				content: `Failed to send invite to ${user}`,
				ephemeral: true,
			};
		}

		return {
			content: `Invite sent to <@${user.id}>!`,
			ephemeral: true,
		};
	},
} as CommandObject;
