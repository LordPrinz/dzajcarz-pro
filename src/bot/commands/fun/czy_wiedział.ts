import { ICommand } from "wokcommands";
import { getRandom } from "../../../utils/oneLiners";

const czyWiedzial = {
	category: "Fun",
	description: "Answers the damn old question",
	slash: "both",

	callback: ({ message, interaction }) => {
		const randomNumber = getRandom(0, 100);

		let replyMessage: string;

		if (randomNumber % 2 === 0) {
			replyMessage = "Wiedział!";
		} else {
			replyMessage = "Nie wiedział sadge bruh";
		}

		if (replyMessage === "Nie wiedział sadge bruh") {
			return replyMessage;
		}

		if (interaction) {
			interaction.channel?.send(replyMessage).then((msg) => {
				msg.react("🙋‍♂️");
			});
			return ":flag_de:";
		}

		if (message) {
			message.react("🙋‍♂️");
			return replyMessage;
		}
	},
} as ICommand;

export default czyWiedzial;
