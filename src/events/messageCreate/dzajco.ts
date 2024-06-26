import { dzajcoGifUrl as gifURL, dzajcoRegex as regex } from "@/conf/bot";
import { checkElementExists } from "@/helpers/redis/list";
import { getRandom } from "@/utils";
import { type Message } from "discord.js";

export default async (message: Message) => {
	const { content } = message;

	if (!regex.test(content)) {
		return;
	}

	const randomNumber = getRandom(1, 2);

	if (randomNumber !== 1) {
		return;
	}

	const isCoDisabled = await checkElementExists(
		"coDisabledFeature",
		message.guild.id
	);

	if (isCoDisabled) {
		return;
	}

	message.react("🥚");
	message.reply(gifURL);
};
