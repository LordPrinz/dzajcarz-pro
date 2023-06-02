import { Player, Queue } from "discord-player";
import client from "./bot";

const player = new Player(client, {
	ytdlOptions: {
		quality: "highestaudio",
		highWaterMark: 1 << 25,
	},
});

player.on("error", (queue, error) => {
	console.log(`Error emitted from the queue ${error.message}`);
	return;
});

player.on("connectionError", (queue, error) => {
	console.log(`Error emitted from the connection ${error.message}`);
	return;
});

player.on("trackStart", (queue: Queue<any>, track) => {
	try {
		if (queue?.repeatMode !== 0) return;

		const channelType = queue?.metadata?.type;

		if (channelType === "GUILD_VOICE" || channelType === "GUILD_STAGE_VOICE") {
			return;
		}

		queue?.metadata?.send(
			`Started playing ${track.title} in **${queue.connection.channel.name}** 🎧`
		);
		return;
	} catch {}
});

player.on("trackAdd", (queue: Queue<any>, track) => {
	const channelType = queue?.metadata?.type;

	if (channelType === "GUILD_VOICE" || channelType === "GUILD_STAGE_VOICE") {
		return;
	}

	try {
		queue?.metadata?.send(
			`Track ${track.title} added in the queue ✅ \n${track.url}`
		);
	} catch {}
	return;
});

player.on("botDisconnect", (queue: Queue<any>) => {
	const channelType = queue?.metadata?.type;

	if (channelType === "GUILD_VOICE" || channelType === "GUILD_STAGE_VOICE") {
		return;
	}

	try {
		queue?.metadata?.send(
			"I was manually disconnected from the voice channel, clearing queue... ❌"
		);
		return;
	} catch {}
});

player.on("channelEmpty", (queue: Queue<any>) => {
	const channelType = queue?.metadata?.type;

	if (channelType === "GUILD_VOICE" || channelType === "GUILD_STAGE_VOICE") {
		return;
	}

	try {
		queue?.metadata?.send(
			"Nobody is in the voice channel, leaving the voice channel... ❌"
		);
		return;
	} catch {}
});

player.on("queueEnd", (queue: Queue<any>) => {
	const channelType = queue?.metadata?.type;

	if (channelType === "GUILD_VOICE" || channelType === "GUILD_STAGE_VOICE") {
		return;
	}

	try {
		queue?.metadata?.send("I finished reading the whole queue ✅");
		return;
	} catch {}
});

player.on('connectionCreate', (queue) => {
	queue.connection.voiceConnection.on("stateChange", (oldState: any, newState: any) => {
		const oldNetworking = Reflect.get(oldState, 'networking');
		const newNetworking = Reflect.get(newState, 'networking');

		const networkStateChangeHandler =  (oldNetworkState: any, newNetworkState: any) => {
			const newUdp = Reflect.get(newNetworkState, 'udp');
			clearInterval(newUdp?.keepAliveInterval);
		}

		oldNetworking?.off('stateChange', networkStateChangeHandler);
		newNetworking?.on('stateChange', networkStateChangeHandler);
	});
});


(globalThis as any).player = player;

export default player;
