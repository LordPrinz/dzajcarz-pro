import {
	Client,
	VoiceState,
	VoiceChannel,
	CategoryChannel,
	GuildBasedChannel,
	ReactionUserManager,
} from "discord.js";
import partyAreaSchema from "../models/party-area-schema";
import PartyArea from "../types/PartyArea";
import { getGuildVCs } from "./../utilities/discord/get";

const channelController = async (client: Client) => {
	client.on(
		"voiceStateUpdate",
		async (oldState: VoiceState, newState: VoiceState) => {
			const guild = oldState.guild;
			let partyData: PartyArea[];
			const partyCategories: CategoryChannel[] = [];
			const partyChannels: VoiceChannel[] = [];
			const splitChannels: GuildBasedChannel[] = [];
			const member = newState.member;

			if (!guild) {
				return;
			}

			if (!partyData!) {
				const results = await partyAreaSchema.find({ guildId: guild.id });

				if (!results) {
					return;
				}

				partyData = results;
			}

			guild.channels.cache.map((channel) => {
				partyData.map((partyDatum) => {
					if (channel.type === "GUILD_CATEGORY") {
						if (channel.id === partyDatum.groupId) {
							partyCategories.push(channel);
						}
					}
				});
			});

			partyData.map((partyDatum) => {
				const splitChannel = guild.channels.cache.get(partyDatum.splitChannelId)!;
				splitChannels.push(splitChannel);
			});

			const voiceChannels = getGuildVCs(guild);

			voiceChannels.map((voiceChannel) => {
				partyCategories.map((partyCategory) => {
					if (voiceChannel.parentId === partyCategory.id) {
						partyChannels.push(voiceChannel);
					}
				});
			});

			partyChannels.map((partyChannel) => {
				partyData.map((data) => {
					if (partyChannel.parentId !== data.groupId) {
						return;
					}
					if (partyChannel.id === data.splitChannelId) {
						return;
					}

					const allMembers = partyChannel.members.size;
					let bots = 0;
					partyChannel.members.map((member) => {
						if (member.user.bot) {
							bots++;
						}
					});
					if (allMembers !== bots) {
						return;
					}

					if (allMembers === bots) {
						const timeout = setTimeout(() => {
							if (!partyChannel) {
								return;
							}

							const membersOnVC = partyChannel.members.size;
							let botsOnVC = 0;

							partyChannel.members.map((member) => {
								if (member.user.bot) {
									botsOnVC++;
								}
							});

							if (membersOnVC !== botsOnVC) {
								clearTimeout(timeout);
								return;
							}

							if (membersOnVC === botsOnVC) {
								partyChannel.delete().catch((error) => {});
							}
						}, 1000 * 60);

						if (allMembers !== 0) {
							return;
						}
					}

					partyChannel.delete().catch((error) => {});
				});
			});

			partyData.map(async (data) => {
				if (newState.channelId === data.splitChannelId) {
					if (!member) {
						return;
					}
					const splitChannel = newState.channel!;

					const newChannelName = data.newChannelName.replace(
						"@",
						`${member?.nickname || member?.user.username}`
					);

					if (!splitChannel) {
						return;
					}
					const newChannel = await splitChannel
						.clone({
							name: newChannelName,
						})
						.catch(() => {});
					member?.voice.setChannel(newChannel!).catch(() => {});
				}
			});
		}
	);

	client.on("channelDelete", async (channel: any) => {
		const deletedChannel = channel;

		if (deletedChannel.type !== "GUILD_CATEGORY") {
			return;
		}

		const guild = channel.guild;

		if (!guild) {
			return;
		}

		let partyData: PartyArea[];

		if (!partyData!) {
			const results = await partyAreaSchema.find({ guildId: guild.id });

			if (!results) {
				return;
			}

			partyData = results;
		}

		partyData.map(async (data) => {
			if (data.groupId !== channel.id) {
				return;
			}

			await partyAreaSchema.findByIdAndRemove(data._id);
		});
	});

	const commandsChannel: string[] = [];

	client.on("channelCreate", async (channel) => {
		if (channel.type !== "GUILD_TEXT") {
			return;
		}

		const guild = channel.guild;

		if (!guild) {
			return;
		}

		const results: PartyArea[] = await partyAreaSchema.find({ guildId: guild.id });

		if (!results) {
			return;
		}

		results.map((result) => {
			if (commandsChannel.includes(result.commandsChannel!)) {
				return;
			}
			commandsChannel.push(result.commandsChannel!);
		});
	});

	client.on("messageCreate", async (message) => {
		const guild = message?.guild;

		if (!guild) {
			return;
		}

		const results: PartyArea[] = await partyAreaSchema.find({ guildId: guild.id });

		if (!results) {
			return;
		}

		if (!results[0]?.commandsChannel) {
			return;
		}

		results.map((result) => {
			if (commandsChannel.includes(result.commandsChannel!)) {
				return;
			}
			commandsChannel.push(result.commandsChannel!);
		});

		if (!commandsChannel.includes(message.channelId)) {
			return;
		}

		const messages = await message.channel.messages.fetch();

		messages.forEach((msg) => {
			if (!msg.deletable) {
				return;
			}

			if (messages.last()?.id === msg.id) {
				return;
			}

			setTimeout(() => {
				if (!msg) {
					return;
				}
				if (msg.deletable) {
					msg.delete().catch((error) => {});
				}
			}, 1000 * 10);
		});
	});
};

export default channelController;

export const config = {
	dbName: "PARTY_AREA",
	displayName: "Party Area",
};
