import { Player, Queue, Track } from "discord-player";
import client from "./index";
import { TextChannel } from "discord.js";

const player = new Player(client, {
	ytdlOptions: {
		quality: "highestaudio",
		highWaterMark: 1 << 25,
	},
});

player.on("error", (queue: Queue<unknown>, error) => {
	throw new Error(`Error emitted from the queue ${error.message}`);
});

player.on("connectionError", (queue: Queue<unknown>, error) => {
	throw new Error(`Error emitted from the connection ${error.message}`);
});

player.on("trackStart", (queue: Queue<unknown>, track: Track) => {
	if (!queue) {
		return;
	}

	if (queue.repeatMode !== 0) return;

	const channel = queue.metadata as TextChannel;

	if (!channel) {
		return;
	}

	channel.send(
		`Started playing ${track.title} in **${queue.connection.channel.name}**`
	);
});

player.on("trackAdd", (queue: Queue<unknown>, track: Track) => {
	const channel = queue?.metadata as TextChannel;

	if (!channel) {
		return;
	}

	channel.send(`Track ${track.title} added in the queue ✅ \n${track.url}`);
});

player.on("channelEmpty", (queue: Queue<unknown>) => {
	const channel = queue?.metadata as TextChannel;

	if (!channel) {
		return;
	}

	channel.send("Nobody is in the voice channel, leaving the voice channel...");
});

player.on("queueEnd", (queue: Queue<unknown>) => {
	const channel = queue?.metadata as TextChannel;

	if (!channel) {
		return;
	}

	channel.send("I finished reading the whole queue.");
});

// Fix for ytdl-core that causes bot disconnect

player.on("connectionCreate", (queue) => {
	queue.connection.voiceConnection.on(
		"stateChange",
		(oldState: any, newState: any) => {
			const oldNetworking = Reflect.get(oldState, "networking");
			const newNetworking = Reflect.get(newState, "networking");

			const networkStateChangeHandler = (_: any, newNetworkState: any) => {
				const newUdp = Reflect.get(newNetworkState, "udp");
				clearInterval(newUdp?.keepAliveInterval);
			};

			oldNetworking?.off("stateChange", networkStateChangeHandler);
			newNetworking?.on("stateChange", networkStateChangeHandler);
		}
	);
});

const botId = client.user?.id;
client.on("voiceStateUpdate", async (oldState, newState) => {
	const guild = newState.guild;
	const queue = player?.getQueue(guild);

	if (!queue) {
		return;
	}

	const newMembers = newState.channel?.members;
	const oldMembers = oldState.channel?.members;
	const isDzajcarzNew = newMembers?.find((member) => member.user.id === botId);
	const isDzajcarzOld = oldMembers?.find((member) => member.user.id === botId);

	const shouldDisconnect = () => !isDzajcarzOld && !isDzajcarzNew;

	if (!shouldDisconnect()) {
		return;
	}

	if (queue.destroyed) {
		return;
	}

	queue.destroy();
});

export default player;
