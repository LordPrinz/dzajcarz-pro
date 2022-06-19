import { ICommand } from "wokcommands";
import { player } from "../../features/player";

const back = {
	category: "music",
	description: "Back to previous music.",
	slash: "both",
	testOnly: true,
	aliases: ["previous"],

	callback: async ({ guild, user, member, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = player(client);

		const queue = discordPlayer?.getQueue(guild?.id);
		if (!queue || !queue.playing)
			return `No music currently playing <@${user.id}>.`;

		if (!queue.previousTracks[1])
			return `There was no music played before <@${user.id}>`;

		await queue.back();

		return `Playing the **previous** track.`;
	},
} as ICommand;

export default back;
