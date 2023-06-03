import { ICommand } from "wokcommands";

export default {
	category: "Fun",
	description: "Replies with current time",
	slash: "both",

	callback: ({ user }) => {
		const today = new Date();

		const fetchedTime = [
			today.getHours(),
			today.getMinutes(),
			today.getSeconds(),
		];

		const currentTime = fetchedTime.map((unit: number) => {
			const transformedUnit = unit < 10 ? `0${unit}` : unit.toString();
			return transformedUnit;
		});

		return `<@${user.id}> ${currentTime[0]}:${currentTime[1]}:${currentTime[2]}`;
	},
} as ICommand;
