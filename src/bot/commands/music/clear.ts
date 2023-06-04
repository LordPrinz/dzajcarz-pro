import { ICommand } from "wokcommands";
import player from "../../player";

const clear = {
	category: "music",
	description: "Clears queue.",
	slash: "both",
	aliases: ["cq"],

	callback: ({ guild, channel, user, member }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const queue = player?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return `No music currently playing <@${user.id}>`;
		}
		if (!queue.tracks[0]) {
			return `No music in the queue after the current one <@${user.id}>`;
		}

		queue.clear();

		channel.send(`The queue has just been cleared`);
	},
} as ICommand;

export default clear;
