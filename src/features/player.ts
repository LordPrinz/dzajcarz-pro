import { Player, Queue } from "discord-player";
import { Client } from "discord.js";

export const player = (client: Client) => {
	try {
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

		player.on("trackStart", (queue:  Queue<any>, track) => {
			if (queue?.repeatMode !== 0) return;
			queue?.metadata?.send(
				`Started playing ${track.title} in **${queue.connection.channel.name}** 🎧`
			);
			return;
		});

		player.on("trackAdd", (queue: Queue<any>, track) => {
			queue?.metadata?.send(
				`Track ${track.title} added in the queue ✅ \n${track.url}`
			);
			return;
		});

		player.on("botDisconnect", (queue:  Queue<any>) => {
			queue?.metadata?.send(
				"I was manually disconnected from the voice channel, clearing queue... ❌"
			);
			return;
		});

		player.on("channelEmpty", (queue:  Queue<any>) => {
			queue?.metadata?.send(
				"Nobody is in the voice channel, leaving the voice channel... ❌"
			);
			return;
		});

		player.on("queueEnd", (queue:  Queue<any>) => {
			queue?.metadata?.send("I finished reading the whole queue ✅");
			return;
		});

		return player;
	} catch (error) {
		console.log("XD");
	}
};

export const config = {
	displayName: "Player",
	dbName: "Player",
};
