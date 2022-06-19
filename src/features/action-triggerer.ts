import { Client, VoiceChannel } from "discord.js";
import decodeScheduledTime from "../utilities/decodeScheduledTime";
import { getGuildVCs, getMostPopulatedVC } from "../utilities/discord/get";
import sendMessageOnServer from "../utilities/discord/sendMessageOnServer";
import sendMessageToUser from "../utilities/discord/sendMessageToUser";
import planAction from "../utilities/planAction";
import planDetails from "./../../data/scheduledSongs.json";

const actionTriggerer = (client: Client) => {
	const guilds = client.guilds.cache.map((guild) => guild);

	const channelsToConnect: VoiceChannel[] = [];

	guilds.map((guild) => {
		const guildChannels = getGuildVCs(guild);
		const mostPopularVC = getMostPopulatedVC(guildChannels);

		channelsToConnect.push(mostPopularVC);
	});

	planDetails.map((planDetail: any) => {
		const time = decodeScheduledTime(planDetail.time);
		if (!time) {
			return "No time was provided!";
		}
		planAction(time, () => {
			if (planDetail?.message) {
				guilds.map((guild) => {
					const data = {
						message: planDetail.message,
						targetId: planDetail.channelId ?? planDetail.userId,
						guild,
					};

					if (planDetail?.channelId) {
						sendMessageOnServer(data);
					}
					if (planDetail?.userId) {
						sendMessageToUser(data);
					}
				});
			}
			// if (planDetail?.song) {
			// 	const trackPath = getSongPath(planDetail?.song);

			// 	channelsToConnect.map((channel) => {
			// 		const resource = createAudioResource(trackPath);
			// 		playOffline(channel, resource);
			// 	});
			// }
		});
	});
};

export default actionTriggerer;

export const config = {
	dbName: "ACTION_TRIGGERER",
	displayName: "Action Triggerer",
};
