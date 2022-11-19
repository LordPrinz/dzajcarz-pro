import { ICommand } from "wokcommands";
import player from "../../player";

const jump = {
	description: "Jump to the specific track.",
	category: "Music",
	minArgs: 1,
	expectedArgs: "<track>",
	slash: "both",
	options: [
		{
			name: "track",
			description: "The number of track to remove",
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

		const queue = player?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return "No music is being played.";
		}

		if (!args) {
			return "You the track number you want to remove.";
		}

		const trackIndex = +args[0] - 1;

		if (!queue.tracks[trackIndex]) {
			return "There is no track with this number.";
		}

		const trackName = queue.tracks[trackIndex].title;
		queue.remove(trackIndex);

		return `**${trackName}** has been removed from the queue!`;
	},
} as ICommand;

export default jump;
