import { Request, Response } from "express";
import catchAsync from "../../utils/server/catchAsync";
import dmChatSchema from "../../bot/models/dm-chat-schema";
import client from "../../bot";

const sendMessage = catchAsync(async (req: Request, res: Response) => {
	const data = req.body;

	const user = await client.users.fetch(data.id);

	if (!user) {
		res.status(404).json({
			status: "fail",
			data: {
				info: "Conversation not found!",
			},
		});

		return;
	}

	user
		.send({
			content: data.content,
			files: data.attachments,
		})
		.catch((error) => {
			res.status(403).json({
				status: "fail",
				data: {
					info: error.name,
				},
			});
		})
		.then((response) => {
			if (!response) {
				return;
			}

			res.status(201).json({
				status: "success",
				data: {
					info: "Message Sent!",
				},
			});
		});
});

const getChat = catchAsync(async (req: Request, res: Response) => {
	const id = req.params.id;

	const chat = await dmChatSchema.find({
		chat: id,
	});

	if (chat.length === 0) {
		res.status(404).json({
			status: "fail",
			results: chat.length,
			data: {
				info: "No chat found",
			},
		});
		return;
	}

	res.status(200).json({
		status: "success",
		results: chat.length,
		data: {
			chat,
		},
	});
});

export default {
	getChat,
	sendMessage,
};
