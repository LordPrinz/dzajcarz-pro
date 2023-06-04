import { ICommand } from "wokcommands";
import axios from "axios";

export default {
	category: "api",
	description: "Returns short version of your link.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<link> <custom_name>",
	options: [
		{
			name: "link",
			description: "Your link.",
			required: true,
			type: "STRING",
		},
		{
			name: "custom_name",
			description: "Cutstom name",
			type: "STRING",
			required: false,
		},
	],

	callback: async ({ args, channel, interaction }) => {
		if (!args[0]) {
			return "You have to pass a link!";
		}

		const [link, customName] = args;

		let body: any = { url: link };

		if (customName) {
			body = { ...body, customName };
		}

		try {
			if (interaction) {
				interaction.reply("Generating link...");
			}

			const result: any = await axios.post(
				"https://www.dzaj.de/api/urls",
				body
			);

			channel.send(`https://dzaj.de/${result.data.shortUrl}`);
		} catch (error: any) {
			const { response } = error;

			if (response.status === 422) {
				return response.data.message;
			}

			if (response.status === 429) {
				return response.data.error;
			}
		}

		return "Something went Wrong!";
	},
} as ICommand;
