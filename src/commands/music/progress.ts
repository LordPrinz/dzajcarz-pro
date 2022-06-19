import { ICommand } from "wokcommands";
import { player } from "../../features/player";

const progress = {
	category: "music",
	description: "Shows playlist progress.",
	slash: "both",
	aliases: ["pbar"],

	callback: async ({ guild, user, member, client }) => {
		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		if (!guild) {
			return "You can not use this command outside of the guild.";
		}
		const discordPlayer = player(client);

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return `No music currently playing <@${user.id}>`;
		}
		const progress = queue.createProgressBar();
		const timestamp = queue.getPlayerTimestamp();

		if (timestamp.progress === Infinity) {
			return `Playing a live, no data to display 🎧`;
		}
		return `${progress} (**${timestamp.progress}**%)`;
	},
} as ICommand;

export default progress;
