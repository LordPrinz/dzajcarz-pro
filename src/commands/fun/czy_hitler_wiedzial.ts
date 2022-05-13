import { ICommand } from "wokcommands";
import getRandom from "../../utilities/getRandom";
import isDivisible from "../../utilities/isDivisible";
import isInteration from "../../utilities/isInteraction";
import isMessage from "../../utilities/isMessage";

const czyHitlerWiedzial = {
	category: "Fun",
	description: "Answers the damn old question",
	slash: "both",

	callback: ({ message, interaction }) => {
		const randomNumber = getRandom(0, 100);

		let replyMessage: string;

		if (isDivisible(randomNumber, 2)) {
			replyMessage = "Wiedział!";
		} else {
			replyMessage = "Nie wiedział sadge bruh";
		}

		if (replyMessage === "Nie wiedział sadge bruh") {
			return replyMessage;
		}

		if (isInteration(interaction)) {
			interaction.channel?.send(replyMessage).then((msg) => {
				msg.react("🙋‍♂️");
			});
			return ":flag_de:";
		}

		if (isMessage(message)) {
			message.react("🙋‍♂️");
			return replyMessage;
		}
	},
} as ICommand;

export default czyHitlerWiedzial;
