import { Request, Response } from "express";
import client from "../../bot";
import dmChatSchema from "../../bot/models/dmChatModel";
import catchAsync from "../../utils/server/catchAsync";
import APIFeatures from "../../utils/server/APIFeatures";

const getAllUsers = catchAsync(async (req: Request, res: Response) => {
	const features = new APIFeatures(dmChatSchema.find(), req.query as any)
		.filter()
		.sort()
		.limitFields()
		.paginate();

	const doc = await features.query;

	console.log(doc);

	let contactsIds: string[] = [];

	doc.map((res: { chat: string }) => {
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
			results: contacts.length,
			data: values,
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
