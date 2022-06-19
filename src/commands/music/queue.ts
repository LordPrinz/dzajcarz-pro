import { MessageEmbed } from "discord.js";
import { ICommand } from "wokcommands";
import { player } from "../../features/player";

const queue = {
	category: "music",
	description: "Displays music queue.",
	slash: "both",
	testOnly: true,
	aliases: ["q"],

	callback: async ({ client, guild, channel, user, member }) => {
		if (!guild) {
			return "You can not use this command outside of the guild.";
		}

		if (!member.voice.channelId) {
			return "You are not on the voice channel.";
		}

		const discordPlayer = player(client);

		const queue = discordPlayer?.getQueue(guild?.id);

		if (!queue) {
			return `No music currently playing <@${user.id}>`;
		}

		if (!queue.tracks[0])
			return `No music in the queue after the current one <@${user.id}>`;

		const embed = new MessageEmbed();
		const methods = ["", "🔁", "🔂"];

		embed.setColor("RED");
		embed.setThumbnail(guild.iconURL({ size: 2048, dynamic: true })!);
		embed.setAuthor(
			`Server queue - ${guild.name} ${methods[queue.repeatMode]}`,
			client.user!.displayAvatarURL({ size: 1024, dynamic: true })
		);

		const tracks = queue.tracks.map(
			(track, index) =>
				`**${index + 1}** - ${track.title} | ${track.author} (requested by : <@${
					track.requestedBy.id
				}>)`
		);

		const songs = queue.tracks.length;
		const nextSongs =
			songs > 5
				? `And **${songs - 5}** other song(s)...`
				: `In the playlist **${songs}** song(s)...`;

		embed.setDescription(
			`Current ${queue.current.title}\n\n${tracks
				.slice(0, 5)
				.join("\n")}\n\n${nextSongs}`
		);
		embed.setTimestamp();
		embed.setFooter({
			text: `${process.env.AUTHOR! || ":)"}`,
			iconURL: guild.iconURL({ size: 2048, dynamic: true })!,
		});

		channel.send({ embeds: [embed] });
	},
} as ICommand;

export default queue;
