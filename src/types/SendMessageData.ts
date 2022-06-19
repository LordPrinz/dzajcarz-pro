import { Guild } from "discord.js";

interface SendMessageData {
	message: string;
	targetId: string;
	guild: Guild;
}

export default SendMessageData;
