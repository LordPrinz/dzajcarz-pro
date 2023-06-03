import { ICommand } from "wokcommands";

export default {
	category: "Fun",
	description: "Replies with pong",
	slash: "both",

	callback: () => {
		return "Pong!";
	},
} as ICommand;
