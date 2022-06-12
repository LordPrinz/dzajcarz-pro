import { ICommand } from "wokcommands";

const purge = {
	category: "Moderation",
	description: "Deletes multiple messeges at once.",

	permissions: ["ADMINISTRATOR"],
	requireRoles: true,

	minArgs: 1,
	expectedArgs: "[amount]",

	slash: "both",

	callback: async ({ message, interaction, channel, args }) => {
		const amount = args.length ? +args.shift()! : 1;

		if (message) {
			await message.delete();
		}

		const messages = await channel.messages.fetch({ limit: amount });

		const { size } = messages;

		messages.map((message) => {
			message.delete();
		});

		const reply = `Deleted ${size} message(s).`;

		if (interaction) {
			return reply;
		}
		channel.send(reply);
	},
} as ICommand;

export default purge;
