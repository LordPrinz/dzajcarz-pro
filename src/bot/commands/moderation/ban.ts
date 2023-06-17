import { User } from "discord.js";
import { ICommand } from "wokcommands";
import punishmentSchema from "../../models/punishmentModel";

const ban: ICommand = {
	category: "Moderation",
	description: "Banishes a user",

	permissions: ["ADMINISTRATOR"],
	requireRoles: true,
	minArgs: 3,
	expectedArgs: "<user> <duration> <reason>",
	expectedArgsTypes: ["USER", "STRING", "STRING"],

	slash: "both",

	callback: async ({
		args,
		member: staff,
		guild,
		client,
		message,
		interaction,
	}) => {
		if (!guild) {
			return "You can only use this in a server.";
		}

		let userId = args.shift()!;
		const duration = args.shift()!;
		const reason = args.join(" ");
		let user: User | undefined;

		if (message) {
			user = message.mentions.users?.first();
		} else {
			user = interaction.options.getUser("user") as User;
		}

		if (!user) {
			userId = userId.replace(/[<@!>]/g, "");
			user = await client.users.fetch(userId);

			if (!user) {
				return `Could not find a user with the ID "${userId}"`;
			}
		}
		userId = user.id;

		let time;
		let type;

		try {
			const split = duration.match(/\d+|\D+/g);
			time = +split![0];
			type = split![1].toLowerCase();
		} catch (err) {
			return "Invalid time format! Example format \"10d\" where 'd' = days, 'h' = hours and 'm' = minutes.";
		}

		switch (type) {
			case "h":
				time *= 60;
				break;
			case "d":
				time *= 60 * 24;
				break;
			case "m":
				break;
			default:
				return 'Please use "m", "h", or "d" for minutes, hours and days respectively.';
		}

		const expires = new Date();
		expires.setMinutes(expires.getMinutes() + time);

		const result = await punishmentSchema.findOne({
			guildId: guild.id,
			userId,
			type: "ban",
		});
		if (result) {
			return `<@${userId}> is already banned in this server.`;
		}
		try {
			await guild.members.ban(userId, { reason: reason });

			await new punishmentSchema({
				userId,
				guildId: guild.id,
				staffId: staff.id,
				reason,
				expires,
				type: "ban",
			}).save();
		} catch (ignored) {
			return "Cannot ban that user.";
		}

		return `<@${userId}> has been banned for "${duration}"`;
	},
};

export default ban;
