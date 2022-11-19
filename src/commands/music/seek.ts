import ms from "ms";
import { ICommand } from "wokcommands";
import player from "../../player";

const seek = {
	category: "music",
	description: "Rewinds music.",
	slash: "both",
	aliases: [],
	minArgs: 1,
	expectedArgs: "<time>",

	callback: async ({ guild, channel, user, args, member, client }) => {
		if (args[0].length === 0) {
			return `<@${user.id}> *Try for example a valid time like **5s, 10s, 20 seconds, 1m**...*`;
		}
		if (!guild) {
			return "You can not use this command outside of a guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const queue = player?.getQueue(guild?.id);

		if (!queue || !queue.playing)
			return channel.send(`No music currently playing  <@${user.id}>`);
		const time: string = args[0];
		const timeToMS = ms(time);
		if (isNaN(timeToMS)) {
			return `The indicated time is higher than the total time of the current song <@${user.id}>\n*Try for example a valid time like **5s, 10s, 20 seconds, 1m**...*`;
		}
		if (timeToMS >= queue.current.durationMS)
			return `The indicated time is higher than the total time of the current song <@${user.id}>\n*Try for example a valid time like **5s, 10s, 20 seconds, 1m**...*`;

		await queue.seek(timeToMS);

		return `Time set on the current song **${ms(timeToMS, {
			long: true,
		})}** ✅`;
	},
} as ICommand;

export default seek;
