import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Replies with current time",
	type: CommandType.BOTH,

	callback({ user }) {
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

		return {
			content: `<@${user.id}> ${currentTime[0]}:${currentTime[1]}:${currentTime[2]}`,
		};
	},
} as CommandObject;
