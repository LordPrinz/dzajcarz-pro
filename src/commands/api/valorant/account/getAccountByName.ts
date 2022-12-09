import { ICommand } from "wokcommands";
import Api from "../../../../libs/ValorantAPI";
import { Region } from "wrapper-valorant-api/lib/types/Region";

const regions = ["ap", "br", "esports", "eu", "kr", "latam", "na"];

const getContents = {
	category: "VALORANT API",
	description: "Get account by riot id",
	slash: "both",
	minArgs: 2,
	expectedArgs: "<gamename> <tagline> <region>",
	testOnly: true,
	options: [
		{
			name: "gamename",
			description: "Your nickname",
			type: "STRING",
			required: true,
		},
		{
			name: "tagline",
			description: "Your tagline",
			type: "STRING",
			required: true,
		},
		{
			name: "region",
			description: "The server you want to get data from.",
			type: "STRING",
			required: false,
			choices: regions.map((region) => ({
				name: region,
				value: region,
			})),
		},
	],

	callback: async ({ args }) => {
		if (!args[0] || !args[1]) {
			return {
				custom: true,
				content: "You have to pass the nickname and tagLine!",
				ephemeral: true,
			};
		}

		const nickname = args[0];
		const tagLine = args[1];
		const region = args[2] as Region;

		const account = await Api.account.getByName({
			// gameName: nickname,
			// tagLine,
			// region,
			gameName: "XD",
			tagLine: "321",
		});

		console.log(account);

		return "OK";
	},
} as ICommand;

export default getContents;
