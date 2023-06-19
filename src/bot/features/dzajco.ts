import { Client, Message } from "discord.js";
import { allowedWords } from "./../../../data/allowedWords.json";
import generateRegex from "../../utils/commands/generateCoRegex";
import { getRandom } from "../../utils/oneLiners";

const dzajco = (client: Client) => {
	client.on("messageCreate", (message: Message) => {
		if (!message) {
			return;
		}

		const regexes: RegExp[] = [];

		allowedWords.map((word) => {
			regexes.push(generateRegex(word));
		});

		regexes.map((regex) => {
			const messageContent = message.content.toLowerCase();
			if (!messageContent.match(regex)) {
				return;
			}

			const number = getRandom(0, 5);

			if (number === 0) {
				message.react("🥚");
				message.reply("https://tenor.com/view/jajco-gif-23924347");
			}
		});
	});
};

export default dzajco;

export const config = {
	dbName: "DZAJCO",
	displayName: "Dzajco",
};
