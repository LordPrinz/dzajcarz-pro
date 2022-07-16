import { ICommand } from "wokcommands";

const shuffle = {
	category: "music",
	description: "Shuffles the queue.",
	slash: "both",
	aliases: ["sh"],

	callback: async ({ guild, user, member, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = (globalThis as any).player;

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return `No music currently playing <@${user.id}>`;
		}

		if (!queue.tracks[0]) {
			return `No music in the queue after the current one <@${user.id}>`;
		}

		await queue?.shuffle();

		return `Queue shuffled **${queue.tracks.length}** song(s) ! ✅`;
	},
} as ICommand;

export default shuffle;
