import { NextFunction, Request, Response } from "express";
import MessageModel from "../../bot/models/messageModel";
import catchAsync from "../../utils/server/catchAsync";
import factory from "./handleFactory";
import client from "../../bot";
import { TextChannel } from "discord.js";
import { formAuthor, formMessage } from "../../utils/commands/dmChatListener";
import { TMessage } from "../../types/TMessage";

const getServerMessages = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const serverId = req.params.serverId;
		const channelId = req.params.channelId;

		const server = client.guilds.cache.find((g) => g.id === serverId);

		if (!server) {
			return res.status(422).json({
				status: "fail",
				results: 0,
				data: "Wrong ID",
			});
		}

		const channel = server?.channels.cache.find(
			(ch) => ch.id === channelId
		) as TextChannel;

		if (!channel) {
			return res.status(422).json({
				status: "fail",
				results: 0,
				data: "Wrong ID",
			});
		}

		const fetchedMessages = await channel.messages.fetch({ limit: 10 });

		const response: TMessage[] = [];

		fetchedMessages.forEach((msg) => {
			// const author = formAuthor(msg);

			const message = formMessage(msg);

			console.log(message);

			// (message as any).author = author;

			response.push(message as any as TMessage);
		});

		res.status(200).json({
			status: "success",
			results: response.length,
			data: response,
		});
	});

const sendDMMessage = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const message = req.body.message;
		const userId = req.params.chat;

		await client.users.send(userId, message);

		res.status(201).json({
			data: "Created",
		});
	});

const sendMessage = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const channel = client.channels.cache.find(
			(ch) => ch.id === req.params.channelId
		);

		if (!channel) {
			return res.status(422).json({
				status: "fail",
				results: 0,
				data: "Wrong ID",
			});
		}

		if (channel.isText()) {
			await channel.send(req.body.message);
		}

		res.status(201).json({
			data: "Created",
		});
	});

export default {
	getAllDMMessages: factory.getAll(MessageModel),
	getDMMessages: factory.getAll(MessageModel),
	getAllMessages: getServerMessages(),
	sendDMMessage: sendDMMessage(),
	sendMessage: sendMessage(),
};
