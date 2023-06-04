import { QueueRepeatMode } from "discord-player";
import { ICommand } from "wokcommands";
import player from "../../player";

const loop = {
	category: "music",
	description: "Loops music.",
	slash: "both",
	aliases: ["lp", "repeat"],
	options: [
		{
			name: "target",
			type: "STRING",
			description: "loop target.",
			required: false,
		},
	],

	callback: async ({ guild, user, args, member }) => {
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

		if (args.join("").toLowerCase() === "queue") {
			if (queue.repeatMode === 1) {
				return `You must first disable the current music in the loop mode (!loop) <@${user.id}>`;
			}

			const success = queue.setRepeatMode(
				queue.repeatMode === 0 ? QueueRepeatMode.QUEUE : QueueRepeatMode.OFF
			);

			return success
				? `Repeat mode **${
						queue.repeatMode === 0 ? "disabled" : "enabled"
				  }** the whole queue will be repeated endlessly 🔁`
				: `Something went wrong <@${user.id}>`;
		} else {
			if (queue.repeatMode === 2) {
				return `You must first disable the current queue in the loop mode (!loop queue) <@${user.id}>`;
			}
			const success = queue.setRepeatMode(
				queue.repeatMode === 0 ? QueueRepeatMode.TRACK : QueueRepeatMode.OFF
			);

			return success
				? `Repeat mode **${
						queue.repeatMode === 0 ? "disabled" : "enabled"
				  }** the current music will be repeated endlessly (you can loop the queue with the <queue> option) 🔂`
				: `Something went wrong <@${user.id}>`;
		}
	},
} as ICommand;

export default loop;
