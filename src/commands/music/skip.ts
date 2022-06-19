import { ICommand } from "wokcommands";
import { player } from "../../features/player";

const skip = {
	category: "music",
	description: "Skips music.",
	slash: "both",
	aliases: ["sk"],

	callback: async ({ guild, user, member, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = player(client);

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue || !queue.playing) {
			return `No music currently playing <@${user.id}>`;
		}
		const success = queue.skip();

		return success
			? `Current music ${queue.current.title} skipped ✅`
			: `Something went wrong <@${user.id}>`;
	},
} as ICommand;

export default skip;
