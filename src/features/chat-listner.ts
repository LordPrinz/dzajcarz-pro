import { Client } from "discord.js";
import { Server, Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io/dist/typed-events";
import dmChatSchema from "../models/dm-chat-schema";

const chatListner = (client: Client) => {
	const ioPort = 2138;

	const io = new Server(ioPort, {
		cors: {
			origin: `http://localhost:3000`,
		},
	});

	let socket: Socket<
		DefaultEventsMap,
		DefaultEventsMap,
		DefaultEventsMap,
		any
	> | null = null;

	io.on("connection", (sck) => {
		socket = sck;
	});

	client.on("messageCreate", async (message) => {
		if (message.channel.type !== "DM") {
			return;
		}

		const content = message?.content;
		const attachments = message?.attachments;
		const author = message?.author;
		const timestamp = message?.createdTimestamp;
		const messageId = message.id;
		let avatar = author.displayAvatarURL();
		const authorId = author.id;
		const authorTag = author.tag;
		const opponent = message.channel.recipient;
		const chat = authorId === process.env.CLIENT_ID ? opponent.id : authorId;

		const transformedAttachments: {
			name: string | null;
			url: string;
			size: number;
			proxyURL: string;
			height: number | null;
			width: number | null;
			contentType: string | null;
		}[] = [];

		attachments.forEach((attachment) => {
			const att = {
				_id: attachment.id,
				name: attachment.name,
				size: attachment.size,
				url: attachment.url,
				proxyURL: attachment.proxyURL,
				height: attachment.height,
				width: attachment.width,
				contentType: attachment.contentType,
			};

			transformedAttachments.push(att);
		});

		const msg = {
			_id: messageId,
			content,
			attachments: transformedAttachments,
			timestamp,
			author: {
				_id: authorId,
				avatar,
				tag: authorTag,
			},
			chat,
		};

		await dmChatSchema.insertMany([msg]);
		if (socket) {
			socket.emit("messageCreate", msg);
		}
	});

	client.on("messageUpdate", async (message) => {
		if (message.channel.type !== "DM") {
			return;
		}

		const messageId = message.id;

		await dmChatSchema.findOneAndUpdate(
			{
				_id: messageId,
			},
			{
				content: message.reactions.message.content,
			},
			{
				upsert: true,
			}
		);
	});

	client.on("messageDelete", async (message) => {
		const messageId = message.id;

		await dmChatSchema.deleteOne({
			_id: messageId,
		});
	});
};

export default chatListner;

export const config = {
	dbName: "CHAT_LISTNER",
	displayName: "Chat Listner",
};
