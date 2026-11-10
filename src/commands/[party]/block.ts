import { getElements } from "@/helpers/redis/list";
import { ApplicationCommandOptionType, type GuildMember } from "discord.js";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Blocks user from your party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	minArgs: 1,
	expectedArgs: "<user>",
	options: [
		{
			name: "user",
			description: "User to block",
			required: true,
			type: ApplicationCommandOptionType.Mentionable,
		},
	],
	callback: async ({ args, guild, member }) => {
		if (!args.length) {
			return { content: "Please mention a user to block", ephemeral: true };
		}

		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to block a user",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only hide party channels",
				ephemeral: true,
			};
		}

		const user = (await guild.members.fetch({
			user: args[0],
		})) as GuildMember;

		channel.permissionOverwrites.edit(user, {
			Connect: false,
			ViewChannel: false,
		});

		return {
			content: `Blocked ${user} from your party channel`,
			ephemeral: true,
		};
	},
} as CommandObject;
