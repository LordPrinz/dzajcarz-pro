import { ICommand } from "wokcommands";
import { isInteration, isMessage } from "../../utilities/discord/typeControll";

export default {
	category: "Fun",
	description: "Replies with current time",

	slash: "both",

	callback: ({ interaction, message }) => {
		const today = new Date();

		const fetchedTime = [today.getHours(), today.getMinutes(), today.getSeconds()];

		const currentTime = fetchedTime.map((unit: number) => {
			const transformedUnit = unit < 10 ? `0${unit}` : unit.toString();
			return transformedUnit;
		});

		let userId: number | undefined | string;

		if (isMessage(message)) {
			userId = message.member?.user.id;
		}

		if (isInteration(interaction)) {
			userId = interaction.member?.user.id;
		}

		return `<@${userId}> ${currentTime[0]}:${currentTime[1]}:${currentTime[2]}`;
	},
} as ICommand;
