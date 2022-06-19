import SendMessageData from "../../types/SendMessageData";

const sendMessageOnServer = (data: SendMessageData) => {
	const message = data.message;
	const channelId = data.targetId;
	const guild = data.guild;

	const channelMap = [
		...guild.channels.cache.filter((ch) => ch.id === channelId),
	];

	if (!channelMap) {
		return;
	}

	const channelObject = channelMap[0];

	if (!channelObject) {
		return;
	}

	const channel = channelObject[1];

	if (!channel) {
		return;
	}

	if (
		channel.type === "GUILD_CATEGORY" ||
		channel.type === "GUILD_STAGE_VOICE" ||
		channel.type === "GUILD_VOICE" ||
		channel.type === "GUILD_STORE"
	) {
		return;
	}

	channel.send(message).catch((err) => {});
};

export default sendMessageOnServer;
