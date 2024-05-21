import { CommandType, type CommandObject } from "wokcommands";

export default {
	description: "Replies with pong",
	type: CommandType.BOTH,

	callback() {
		return {
			content: "Pong!",
		};
	},
} as CommandObject;
