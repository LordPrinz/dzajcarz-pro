import { Message, PartialMessage } from "discord.js";
import { Server } from "socket.io";
import messageModel from "../models/messageModel";
import {
	checkDMChannelExistence,
	checkUserExistence,
	formAuthor,
	formMessage,
	isBot,
	isDmChannel,
} from "../../utils/commands/dmChatListener";
import userSchema from "../models/userModel";
import DMChat from "../models/DMChatModel";

export const messageCreateHandler = async (
	socket: Server | null,
	message: Message
) => {
	const authorId = message.author.id;

	const doesUserExist = await checkUserExistence(authorId);

	if (!doesUserExist) {
		const author = formAuthor(message);
		await userSchema.insertMany([author]);
	}

	if (!isDmChannel(message)) {
		return;
	}

	const doesDMChannelExistYet = await checkDMChannelExistence(authorId);

	if (!doesDMChannelExistYet && !isBot(authorId)) {
		await DMChat.insertMany([{ _id: authorId }]);
	}

	const msg = formMessage(message);
	await messageModel.insertMany([msg]);

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

	await messageModel.findOneAndUpdate(
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

	await messageModel.deleteOne({
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
