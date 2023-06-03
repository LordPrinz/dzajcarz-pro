import { TextChannel, VoiceChannel } from "discord.js";

const generateInvitation = async (channel: TextChannel | VoiceChannel) => {
	return await channel.createInvite({
		unique: true,
	});
};

export default generateInvitation;
