import { QueryType } from "discord-player";
import { MessageEmbed } from "discord.js";
import { ICommand } from "wokcommands";
import player from "../../player";

const clear = {
	category: "music",
	description: "Back to previous music.",
	slash: "both",
	aliases: [],
	minArgs: 1,
	expectedArgs: "<search>",

	callback: async ({ guild, channel, user, member, args, client }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		if (!args[0]) {
			return `Please enter a valid search <@${user.id}>.`;
		}

		const res = await player?.search(args.join(" "), {
			requestedBy: member,
			searchEngine: QueryType.AUTO,
		});

		if (!res || !res.tracks.length) {
			return `No results found <@${user.id}>.`;
		}

		const queue = player?.createQueue(guild, {
			metadata: channel,
		});

		const embed = new MessageEmbed();

		embed.setColor("RED");
		embed.setAuthor(
			`Results for ${args.join(" ")}`,
			user.displayAvatarURL({ size: 1024, dynamic: true })
		);

		const maxTracks = res.tracks.slice(0, 10);

		embed.setDescription(
			`${maxTracks
				.map(
					(track: { title: any; author: any }, i: number) =>
						`**${i + 1}**. ${track.title} | ${track.author}`
				)
				.join("\n")}\n\nSelect choice between **1** and **${
				maxTracks.length
			}** or **cancel** ⬇️`
		);

		embed.setTimestamp();
		embed.setFooter({
			text: `${process.env.AUTHOR! || ":)"}`,
			iconURL: guild.iconURL({ size: 2048, dynamic: true })!,
		});

		channel.send({ embeds: [embed] });

		const collector = channel.createMessageCollector({
			time: 15000,
			filter: (m) => m.author.id === user.id,
		});

		collector.on("collect", async (query) => {
			if (query.content.toLowerCase() === "cancel")
				return `Search cancelled ✅` && collector.stop();

			const value = parseInt(query.content);

			if (!value || value <= 0 || value > maxTracks.length)
				return `Invalid response, try a value between **1** and **${maxTracks.length}** or **cancel**... `;

			collector.stop();

			try {
				if (!queue?.connection) await queue?.connect(member.voice.channel!);
			} catch {
				player?.deleteQueue(guild?.id);
				return `I can't join the voice channel  <@${user.id}> `;
			}

			await channel.send(`Loading your search... 🎧`);

			queue?.addTrack(res.tracks[+query.content - 1]);

			if (!queue?.playing) await queue?.play();
		});

		collector.on("end", (message, reason) => {
			if (reason === "time") {
				return `Search timed out <@${user.id}>`;
			}
		});
	},
} as ICommand;

export default clear;
