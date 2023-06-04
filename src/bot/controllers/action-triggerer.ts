import {
	Client,
	Guild,
	NewsChannel,
	TextChannel,
	ThreadChannel,
	VoiceChannel,
} from "discord.js";
import getFiles, {
	getGuildTextChannels,
	getGuildVCs,
	getMostPopulatedVC,
} from "../../utils/getData";
import path from "path";
import {
	createAudioPlayer,
	createAudioResource,
	DiscordGatewayAdapterCreator,
	getVoiceConnection,
	joinVoiceChannel,
} from "@discordjs/voice";
import { QueryType } from "discord-player";
import player from "../player";
import { shuffle } from "../../utils/oneLiners";

const playOffline = async (trackName: string, guild: Guild) => {
	const suffix = "mp3";

	const musicFolderPath = path.join(__dirname, "../../../data/music");

	const trackPaths = getFiles(musicFolderPath, suffix);

	if (!trackName) {
		shuffle(trackPaths);

		const resource = createAudioResource(trackPaths[0]);

		const connection = getVoiceConnection(guild?.id!);

		const player = createAudioPlayer();
		player.play(resource);
		connection?.subscribe(player);

		player.on("stateChange", () => {
			if (player.state.status === "idle") {
				connection?.destroy();
			}
		});

		return "Playing random song!";
	}

	const trackNames: string[] = [];

	trackPaths.map((track: any) => {
		const trackName = track.split("/");
		const length = trackName.length;
		trackNames.push(trackName[length - 1].replace(".mp3", ""));
	});

	const found = trackNames.find(
		(track) =>
			track.replace(/-/g, " ").toLowerCase() === trackName.toLowerCase()
	);

	if (!found) {
		return "Unknown song.";
	}

	let trackIndex: number;

	trackPaths.map((trackPath: string, index: number) => {
		if (trackPath.match(found)) {
			trackIndex = index;
		}
	});

	const resource = createAudioResource(trackPaths[trackIndex!]);
	const connection = getVoiceConnection(guild?.id!);

	const player = createAudioPlayer();
	player.play(resource);
	connection?.subscribe(player);

	player.on("stateChange", () => {
		if (player.state.status === "idle") {
			connection?.destroy();
		}
	});

	return `Playing ${found}! 🎶`;
};

const playOnline = async ({
	song,
	guild,
	channel,
}: {
	song: string;
	guild: Guild;
	channel: VoiceChannel;
}) => {
	const discordPlayer = player;

	const response = await discordPlayer.search(song, {
		requestedBy: "Bot",
		searchEngine: QueryType.AUTO,
	});

	if (!response || !response.tracks.length) {
		return;
	}

	const queue = discordPlayer.createQueue(guild, {
		metadata: channel,
	});

	try {
		if (!queue.connection) await queue.connect(channel);
	} catch {
		discordPlayer.deleteQueue(guild?.id);
	}

	response.playlist
		? queue.addTracks(response.tracks)
		: queue.addTrack(response.tracks[0]);

	if (!queue.playing) await queue.play();
};

export default class ActionTriggererFeatures {
	client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async sendMessageUser(args: { userId: string; message: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const userPromise = guilds.map(async (guild) => {
			const user = await guild.members
				.fetch({ user: args.userId })
				.catch((error) => {});

			return user;
		});

		const users = await Promise.all(userPromise);

		const user = users.find((user) => !!user);

		if (!user) {
			return;
		}

		user?.send(args.message).catch((error) => {
			console.log(
				`${user.user.username} blocked me or something went wrong! :(`
			);
		});
	}

	sendMessageChannel(args: { channelId: string; message: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const textChannels = guilds.map((guild) => {
			return getGuildTextChannels(guild);
		});

		const channel = textChannels
			.map((channel) => {
				return channel.find((ch) => ch.id === args.channelId);
			})
			.find((channel) => !!channel);

		if (!channel) {
			return;
		}

		(channel as NewsChannel | TextChannel | ThreadChannel)?.send(args.message);
	}
	playOfflineOnCertainChannel(args: { song: string; channelId: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const voiceChannels = guilds.map((guild) => {
			return getGuildVCs(guild);
		});

		const channel = voiceChannels
			.map((channel) => {
				return channel.find((ch) => ch.id === args.channelId);
			})
			.find((channel) => !!channel);

		if (!channel) {
			return;
		}

		joinVoiceChannel({
			channelId: args.channelId,
			guildId: channel?.guild?.id!,
			adapterCreator: channel?.guild
				.voiceAdapterCreator as DiscordGatewayAdapterCreator,
		});

		playOffline(args.song, channel.guild);
	}
	async playOnlineOnCertainChannel(args: { song: string; channelId: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const voiceChannels = guilds.map((guild) => {
			return getGuildVCs(guild);
		});

		const channel = voiceChannels
			.map((channel) => {
				return channel.find((ch) => ch.id === args.channelId);
			})
			.find((channel) => !!channel);

		if (!channel) {
			return;
		}

		playOnline({ song: args.song, channel, guild: channel.guild });
	}
	playOfflineMostPopularEvery(args: { song: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		guilds.map((guild) => {
			const VCs = getGuildVCs(guild);
			if (!VCs.length) {
				return;
			}

			const channel = getMostPopulatedVC(VCs);

			joinVoiceChannel({
				channelId: channel.id,
				guildId: channel.guild.id,
				adapterCreator: channel?.guild
					.voiceAdapterCreator as DiscordGatewayAdapterCreator,
			});

			playOffline(args.song, channel.guild);
		});
	}
	playOnlineMostPopularEvery(args: { song: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		guilds.map(async (guild) => {
			const VCs = getGuildVCs(guild);
			if (!VCs.length) {
				return;
			}

			const channel = getMostPopulatedVC(VCs);

			if (!channel) {
				return;
			}

			playOnline({ song: args.song, guild: channel.guild, channel });
		});
	}
	playOfflineMostPopularCertain(args: { song: string; guildId: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const guild = guilds.find((guild) => guild.id === args.guildId);

		if (!guild) {
			return;
		}

		const VCs = getGuildVCs(guild);

		if (!VCs.length) {
			return;
		}

		const channel = getMostPopulatedVC(VCs);

		joinVoiceChannel({
			channelId: channel.id,
			guildId: args.guildId,
			adapterCreator: channel?.guild
				.voiceAdapterCreator as DiscordGatewayAdapterCreator,
		});

		playOffline(args.song, channel.guild);
	}
	async playOnlineMostPopularCertain(args: { song: string; guildId: string }) {
		const guilds = this.client.guilds.cache.map((guild) => guild);

		const guild = guilds.find((guild) => guild.id === args.guildId);

		if (!guild) {
			return;
		}

		const VCs = getGuildVCs(guild);

		if (!VCs.length) {
			return;
		}

		const channel = getMostPopulatedVC(VCs);

		if (!channel) {
			return;
		}

		playOnline({ song: args.song, guild, channel });
	}
}
