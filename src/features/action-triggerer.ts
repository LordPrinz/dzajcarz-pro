import { Client } from "discord.js";
import ActionTriggererFeatures from "../controllers/action-triggerer";
import Scheduled from "../types/Scheduled";
import scheduledAction from "./../../data/scheduledSongs.json";

const actionTriggerer = (client: Client) => {
	const actions = new ActionTriggererFeatures(client);

	scheduledAction.map((action: Scheduled) => {
		if (!action.time?.length) {
			return;
		}
		if (action.song) {
			if (!action.channelId?.length) {
				if (!action.guildId?.length) {
					if (action.isOnline) {
						action.time.map((time) => {
							if (!time) {
								return;
							}
							actions.playOnlineMostPopularEvery({ song: action.song! });
							return;
						});
						return;
					}
					action.time.map((time) => {
						if (!time) {
							return;
						}
						actions.playOfflineMostPopularEvery({ song: action.song! });
						return;
					});
					return;
				}

				if (action.isOnline) {
					action.time.map((time) => {
						if (!time) {
							return;
						}
						actions.playOnlineMostPopularCertain();
						return;
					});
					return;
				}

				action.time.map((time) => {
					if (!time) {
						return;
					}

					action.guildId!.map((guildId) => {
						actions.playOfflineMostPopularCertain({ song: action.song!, guildId });
					});

					return;
				});
				return;
			}

			if (action.isOnline) {
				action.time.map((time) => {
					if (!time) {
						return;
					}
					actions.playOnlineOnCertainChannel();
					return;
				});
				return;
			}
			action.channelId.map((channelId) => {
				action.time.map((time) => {
					if (!time) {
						return;
					}
					actions.playOfflineOnCertainChannel({
						song: action.song!,
						channelId: channelId,
					});
				});
			});
		}

		if (action.message) {
			if (action.userId?.length) {
				action.userId.map((userId) => {
					if (!userId) {
						return;
					}

					action.time.map((time) => {
						if (!time) {
							return;
						}

						actions.sendMessageUser({
							userId,
							message: action.message!,
						});
					});
				});
			}

			if (action.channelId?.length) {
				action.channelId.map((channelId) => {
					if (!channelId) {
						return;
					}
					action.time.map((time) => {
						if (!time) {
							return;
						}

						actions.sendMessageChannel({
							channelId,
							message: action.message!,
						});
					});
				});
			}
		}
	});
};

export default actionTriggerer;

export const config = {
	dbName: "ACTION_TRIGGERER",
	displayName: "Action Triggerer",
};
