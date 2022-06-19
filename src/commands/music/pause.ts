import { ICommand } from "wokcommands";
import { player } from "../../features/player";

const pause = {
	category: "music",
	description: "Pauses the  music.",
	slash: "both",
	testOnly: true,
	aliases: [],

	callback: async ({ guild, user, member, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = player(client);

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue) return `No music currently playing <@${user.id}>`;

		const success = queue.setPaused(true);

		return success
			? `Current music ${queue.current.title} paused ✅`
			: `Something went wrong <@${user.id}>`;
	},
} as ICommand;

export default pause;
