import { Client } from "discord.js";
import player from "../player";
const musicBotDisconnect = (client: Client) => {
	const botId = client.user?.id;
	client.on("voiceStateUpdate", async (_, newState) => {
		const newMembers = newState.channel?.members;
		const isBot = newMembers?.find((member) => member.user.id === botId);
		const guild = newState.guild;

		if (isBot) {
			return;
		}

		const queue = player?.getQueue(guild);

		if (!queue) {
			return;
		}

		if (queue.destroyed) {
			return;
		}

		queue.destroy();
	});
};

export default musicBotDisconnect;
