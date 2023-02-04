import { ICommand } from "wokcommands";
import axios from "axios";

export default {
	category: "api",
	description: "Returns how many times link has been visited.",
	slash: "both",
	minArgs: 1,
	expectedArgs: "<link>",
	options: [
		{
			name: "link",
			description: "Your link.",
			required: true,
			type: "STRING",
		},
	],

	callback: async ({ args }) => {
		if (!args[0]) {
			return "You have to pass a link!";
		}

		const linkCode = args[0]
			.replace("https://www.dzaj.de/", "")
			.replace("https://dzaj.de/", "")
			.replace("/", "");

		try {
			const result: any = await axios.get(
				`https://www.dzaj.de/api/urls/${linkCode}/stats`
			);

			return `Clicks: ${result.data.clicks}`;
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
