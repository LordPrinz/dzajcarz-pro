import { ICommand } from "wokcommands";

const jump = {
	description: "Jump to the specific track.",
	category: "Music",
	minArgs: 1,
	expectedArgs: "<track>",
	slash: "both",
	options: [
		{
			name: "track",
			description: "Number of the track",
			type: "INTEGER",
			required: true,
		},
	],
	callback: ({ guild, args, member, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = (globalThis as any).player;

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return "No music is being played.";
		}

		if (!args) {
			return "You the track number you want to skip.";
		}

		const trackIndex = +args[0] - 1;

		if (!queue.tracks[trackIndex]) {
			return "There is no track with this number.";
		}

		const trackName = queue.tracks[trackIndex].title;
		queue.jump(trackIndex);

		return `**${trackName}** has jumped the queue!`;
	},
} as ICommand;

export default jump;
