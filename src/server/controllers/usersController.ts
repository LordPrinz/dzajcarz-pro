import { Request, Response } from "express";
import client from "../../bot";
import dmChatSchema from "../../bot/models/dm-chat-schema";
import catchAsync from "../../utils/server/catchAsync";

const getAllUsers = catchAsync(async (_: Request, res: Response) => {
	const response = await dmChatSchema.find();
	let contactsIds: string[] = [];

	response.map((res) => {
		contactsIds.push(res.chat);
	});

	contactsIds = [...new Set(contactsIds)];

	const contacts = contactsIds.map(async (id) => {
		const contact = await client.users.fetch(id).then((data) => {
			const contact = {
				id: data.id,
				username: data.username,
				discriminator: data.discriminator,
				avatar: data.displayAvatarURL(),
			};

			return contact;
		});

		return contact;
	});

	Promise.all(contacts).then((values) => {
		res.status(200).json({
			status: "success",
			results: 1,
			data: {
				contacts: values,
			},
		});
	});
});

const getUser = catchAsync(async (req: Request, res: Response) => {
	const id = req.params.id;

	if (isNaN(+id)) {
		res.status(400).json({
			status: "fail",
			results: 0,
			data: {
				info: "Wrong ID",
			},
		});
		return;
	}

	const user = await client.users.fetch(id).catch(() => {
		res.status(404).json({
			status: "fail",
			results: 0,
			data: {
				info: "No users found",
			},
		});
		return;
	});

	if (!user) {
		res.status(404).json({
			status: "fail",
			results: 0,
			data: {
				info: "No users found",
			},
		});
		return;
	}

	res.status(200).json({
		status: "success",
		results: 1,
		data: {
			user,
		},
	});
});

export default {
	getAllUsers,
	getUser,
};
