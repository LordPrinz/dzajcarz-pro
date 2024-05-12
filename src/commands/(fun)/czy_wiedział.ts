import { getRandom } from "@/utils";
import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Answers the damn old question",
	type: CommandType.BOTH,

	callback: async ({ interaction, message }) => {
		const randomNumber = getRandom(0, 2);

		let replyMessage = "";

		if (randomNumber === 0) {
			replyMessage = "Wiedział!";
		} else {
			replyMessage = "Nie wiedział sadge bruh";
		}

		if (randomNumber !== 0) {
			return {
				content: replyMessage,
			};
		}

		if (interaction) {
			interaction.channel.send(replyMessage).then((msg) => {
				msg.react("🙋‍♂️");
			});

			return ":flag_de:";
		}

		message.react("🙋‍♂️");
		return replyMessage;
	},
} as CommandObject;
