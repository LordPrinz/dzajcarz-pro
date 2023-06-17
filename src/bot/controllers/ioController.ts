import { Message, PartialMessage } from "discord.js";
import { Server } from "socket.io";
import dmChatSchema from "../models/dmChatModel";
import {
	checkUserExistence,
	formAuthor,
	formMessage,
	isDmChannel,
} from "../../utils/commands/dmChatListener";
import userSchema from "../models/userModel";

export const messageCreateHandler = async (
	socket: Server | null,
	message: Message
) => {
	if (!isDmChannel(message)) {
		return;
	}

	const doesUserExist = await checkUserExistence(message.author.id);

	if (!doesUserExist) {
		const author = formAuthor(message);
		await userSchema.insertMany([author]);
	}

	const msg = formMessage(message);
	await dmChatSchema.insertMany([msg]);

	socket?.emit("messageCreate", msg);
};

export const messageUpdateHandler = async (
	socket: Server | null,
	message: Message | PartialMessage,
	newMessage: Message | PartialMessage
) => {
	if (!isDmChannel(message)) {
		return;
	}

	const messageId = message.id;

	const msg = formMessage(newMessage);

	await dmChatSchema.findOneAndUpdate(
		{
			_id: messageId,
		},
		{
			content: msg,
		},
		{
			upsert: true,
		}
	);

	socket?.emit("messageUpdate", {
		messageId,
		message: msg,
	});
};

export const messageDeleteHandler = async (
	socket: Server | null,
	message: Message | PartialMessage
) => {
	if (!isDmChannel(message)) {
		return;
	}

	const messageId = message.id;

	await dmChatSchema.deleteOne({
		_id: messageId,
	});

	if (!socket) {
		return;
	}

	const msg = formMessage(message);

	socket.emit("messageUpdate", {
		messageId,
		message: msg,
	});
};
