import { Client } from "discord.js";
import express from "express";
import dmChatSchema from "../models/dm-chat-schema";
import cors from "cors";

const port = 4761;

const app = express();

app.use(express.json());
app.use(cors());

const server = (client: Client) => {
	app.get("/", async (req, res) => {
		const messages = await dmChatSchema.find();

		res.status(200).json({
			status: "success",
			results: messages.length,
			data: {
				messages,
			},
		});
	});

	app.get("/contacts", async (req, res) => {
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

	app.get("/contacts/:id", async (req, res) => {
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

	app.get("/messages/:id", async (req, res) => {
		const id = req.params.id;
		const message = await dmChatSchema.findById(id);

		res.status(200).json({
			status: !!+!!message ? "success" : "fail",
			results: +!!message,
			data: {
				message,
			},
		});
	});

	app.get("/chat/:id", async (req, res) => {
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

	app.post("/chat/:id", async (req, res) => {
		const data = req.body;

		const user = await client.users.fetch(data.id).catch((err) => {});

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
};

app.listen(port, () => {
	console.log(`App running on port ${port}`);
});

export const config = {
	dbName: "server",
	displayName: "server",
};

export default server;
