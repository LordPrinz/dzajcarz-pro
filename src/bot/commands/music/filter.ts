import { ICommand } from "wokcommands";
import player from "../../player";

const clear = {
	category: "music",
	description: "Music special Effect.",
	slash: "both",
	aliases: [],
	minArgs: 1,
	expectedArgs: "<filter>",
	options: [
		{
			name: "action",
			description: `The name of the filter.`,
			type: "STRING",
			required: true,
		},
	],
	callback: async ({ guild, user, args, member }) => {
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

		const actualFilter = queue.getFiltersEnabled()[0];

		if (!args[0]) {
			return `Please specify a valid filter to enable or disable <@${
				user.id
			}>\n${
				actualFilter
					? `Filter currently active ${actualFilter} (!filter ${actualFilter} to disable it).\n`
					: ""
			}`;
		}
		const filters: any = [];

		queue.getFiltersEnabled().map((value: any) => filters.push(value));
		queue.getFiltersDisabled().map((value: any) => filters.push(value));

		const filter = filters.find(
			(value: any) => value.toLowerCase() === args[0].toLowerCase()
		);

		if (!filter)
			return `This filter doesn't exist <@${user.id}>\n${
				actualFilter ? `Filter currently active ${actualFilter}.\n` : ""
			}List of available filters ${filters
				.map((value: any) => `**${value}**`)
				.join(", ")}.`;

		const filtersUpdated: any = {};

		filtersUpdated[filter] = queue.getFiltersEnabled().includes(filter)
			? false
			: true;

		await queue.setFilters(filtersUpdated);

		return `The filter ${filter} is now **${
			queue.getFiltersEnabled().includes(filter) ? "enabled" : "disabled"
		}** \n*Reminder the longer the music is, the longer this will take.*`;
	},
} as ICommand;

export default clear;
