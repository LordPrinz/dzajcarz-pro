import { ICommand } from "wokcommands";
import player from "../../player";

const maxVol = 100;

const volume = {
	category: "music",
	description: "Regulates the volume.",
	slash: "both",
	aliases: ["vol"],
	minArgs: 1,
	expectedArgs: "<volume>",

	callback: async ({ guild, user, args, member, client }) => {
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
		const vol = +args[0];

		if (!vol) {
			return `The current volume is ${queue.volume} 🔊\n*To change the volume enter a valid number between **1** and **${maxVol}**.*`;
		}

		if (queue.volume === vol) {
			return `The volume you want to change is already the current one <@${user.id}>.`;
		}

		if (vol < 0 || vol > maxVol) {
			return `The specified number is not valid. Enter a number between **1** and **${maxVol}** <@${user.id}>.`;
		}

		const success = queue.setVolume(vol);

		return success
			? `The volume has been modified to **${vol}**/**${maxVol}**% 🔊`
			: `Something went wrong <@${user.id}>`;
	},
} as ICommand;

export default volume;
