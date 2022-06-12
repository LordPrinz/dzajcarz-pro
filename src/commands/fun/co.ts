import { Client, Message } from "discord.js";
import { ICommand } from "wokcommands";
import allowedWords from "../../../data/allowedWords";
import generateRegex from "../../utilities/generateRegex";
import getRandomInt from "../../utilities/getRandom";

export default {
	category: "Fun",
	description: "Answers the question.",

	slash: "both",

	init: (client: Client) => {
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

				let replyMessage: string;
				const number = getRandomInt(0, 5);

				if (number === 0) {
					replyMessage = "https://tenor.com/view/jajco-gif-23924347";
					message.react("🥚");
					message.reply(replyMessage);
				}
			});
		});
	},

	callback: () => {
		return "https://tenor.com/view/jajco-gif-23924347";
	},
} as ICommand;
