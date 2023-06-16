import { Client } from "discord.js";
import player from "../player";
const musicBotDisconnect = (client: Client) => {
	const botId = client.user?.id;
	client.on("voiceStateUpdate", async (oldState, newState) => {
		const guild = newState.guild;
		const queue = player?.getQueue(guild);

		if (!queue) {
			return;
		}

		const newMembers = newState.channel?.members;
		const oldMembers = oldState.channel?.members;
		const isDzajcarzNew = newMembers?.find(
			(member) => member.user.id === botId
		);
		const isDzajcarzOld = oldMembers?.find(
			(member) => member.user.id === botId
		);

		const shouldDisconnect = () => !isDzajcarzOld && !isDzajcarzNew;

		if (!shouldDisconnect()) {
			return;
		}

		if (queue.destroyed) {
			return;
		}

		queue.destroy();
	});
};

export default musicBotDisconnect;
