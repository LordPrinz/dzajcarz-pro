import { Request, Response } from "express";
import catchAsync from "../../utils/server/catchAsync";
import dmChatSchema from "../../bot/models/dmChatModel";
import client from "../../bot";
import handleFactory from "./handleFactory";

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

export default {
	getChat: handleFactory.getAll(dmChatSchema),
	sendMessage,
};
