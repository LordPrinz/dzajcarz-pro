import { ICommand } from "wokcommands";
import player from "../../player";

const save = {
	category: "music",
	description: "Sends you music name via DM.",
	slash: "both",
	aliases: ["sv"],

	callback: async ({ guild, user, member }) => {
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

		user
			.send(
				`You saved the track ${queue.current.title} | ${queue.current.author} from the server ${guild?.name} ✅`
			)
			.then(() => {
				return `I have sent you the title of the music by private messages ✅`;
			})
			.catch((error) => {
				return `Unable to send you a private message <@${user.id}>`;
			});
	},
} as ICommand;

export default save;
