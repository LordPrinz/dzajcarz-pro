import {
	Client,
	MessageActionRow,
	MessageButton,
	MessageEmbed,
} from "discord.js";
import { ICommand } from "wokcommands";
import player from "../../player";

const nowPlaying = {
	category: "music",
	description: "Shows what is playing right now.",
	slash: "both",
	aliases: ["np"],
	init: (client: Client) => {
		client.on("interactionCreate", (interaction) => {
			if (!interaction.isButton()) {
				return;
			}

			const guild = interaction.guild;
			const channel = interaction.channel;
			if (!guild) {
				return;
			}

			const discordPlayer = (globalThis as any).player;

			const queue = discordPlayer?.getQueue(guild?.id);

			switch (interaction.customId) {
				case "saveTrack": {
					if (!queue || !queue.playing)
						return interaction.reply({
							content: `No music currently playing... try again ?`,
							ephemeral: true,
							components: [],
						});

					if (!channel) {
						return;
					}

					interaction.user
						.send(
							`You saved the track ${queue.current.title} | ${queue.current.author} from the server ${guild.name} ✅`
						)
						.then(() => {
							return interaction.reply({
								content: `I have sent you the title of the music by private messages ✅`,
								ephemeral: true,
								components: [],
							});
						})
						.catch((error) => {
							return interaction.reply({
								content: `Unable to send you a private message... try again ? ❌`,
								ephemeral: true,
								components: [],
							});
						});
				}
			}
		});
	},

	callback: async ({ guild, channel, user, member }) => {
		try {
			if (!guild) {
				return "You can not use this command outside of the guild.";
			}

			if (!member.voice.channelId) {
				return "You are not on the voice channel.";
			}

			const queue = player?.getQueue(guild?.id);

			if (!queue || !queue.playing) {
				return `No music currently playing <@${user.id}>`;
			}

			const track = queue.current;

			const embed = new MessageEmbed();

			embed.setColor("RED");
			embed.setThumbnail(track.thumbnail);
			embed.setAuthor({
				name: track.title,
				iconURL: user.displayAvatarURL({ size: 1024, dynamic: true }),
			});

			const methods = ["disabled", "track", "queue"];

			const timestamp = queue.getPlayerTimestamp();
			const trackDuration =
				timestamp.progress === Infinity ? "infinity (live)" : track.duration;

			embed.setDescription(
				`Volume **${
					queue.volume
				}**%\nDuration **${trackDuration}**\nLoop mode **${
					methods[queue.repeatMode]
				}**\nRequested by <@${track.requestedBy.id}>`
			);

			embed.setTimestamp();
			embed.setFooter({
				text: `${process.env.AUTHOR! || ":)"}`,
				iconURL: guild.iconURL({ size: 2048, dynamic: true })!,
			});

			const saveButton = new MessageButton();

			saveButton.setLabel("Save this track");
			saveButton.setCustomId("saveTrack");
			saveButton.setStyle("SUCCESS");

			const row = new MessageActionRow().addComponents(saveButton);

			channel.send({ embeds: [embed], components: [row] });
		} catch (error) {}
	},
} as ICommand;

export default nowPlaying;
