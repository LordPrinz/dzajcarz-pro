import { Message } from "discord.js";

export default (message: Message) => {
	console.log(message.content);
};
