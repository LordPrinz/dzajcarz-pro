import { NextFunction, Request, Response } from "express";
import MessageModel from "../../bot/models/messageModel";
import catchAsync from "../../utils/server/catchAsync";
import factory from "./handleFactory";
import client from "../../bot";
import { Message, TextChannel } from "discord.js";
import { formMessage } from "../../utils/commands/dmChatListener";
import { TMessage } from "../../types/TMessage";
import AppError from "../../utils/server/AppError";
import {
	sendEmptyMessages,
	sendWrongIdError,
} from "../../utils/server/validateId";

const getServerMessages = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const serverId = req.params.serverId;
		const channelId = req.params.channelId;
		const { limit, page, beforeId } = req.query;

		const server = client.guilds.cache.find((g) => g.id === serverId);

		if (!server) {
			return sendWrongIdError(res);
		}

		const channel = server.channels.cache.find(
			(ch) => ch.id === channelId
		) as TextChannel | null;

		if (!channel) {
			return sendWrongIdError(res);
		}

		const messagesPerPage = limit ? parseInt(limit as string) : 20;
		const currentPage = page ? parseInt(page as string) : 1;

		let paginatedMessages: Message[];

		const messageNumber = currentPage * messagesPerPage;

		if (beforeId) {
			const limitation = parseInt(limit as string);
			const fetchLimit = limitation > 100 ? 100 : limitation;

			const fetchedMessages = await channel.messages.fetch({
				limit: fetchLimit,
				before: beforeId as string,
			});

			paginatedMessages = Array.from(fetchedMessages.values());
		} else if (messageNumber <= 100) {
			const fetchedMessages = await channel.messages.fetch({
				limit: messageNumber,
			});

			const startIndex = (currentPage - 1) * messagesPerPage;
			const endIndex = startIndex + messagesPerPage;

			paginatedMessages = Array.from(fetchedMessages.values()).slice(
				startIndex,
				endIndex
			);
		} else {
			let lastMessageId: string | undefined;
			let messages;

			for (let i = 0; i < messageNumber / 100; i++) {
				messages = await channel.messages.fetch({
					before: lastMessageId,
					limit: 100,
				});

				lastMessageId = messages.last()?.id;

				if (!lastMessageId) {
					return sendEmptyMessages(res);
				}
			}

			if (!messages) {
				return sendEmptyMessages(res);
			}

			const messagesLength = messages.size;

			const limitation = req.query.limit as any as number;

			const endIndex =
				Math.floor(currentPage % (messagesLength / limitation)) === 0
					? messagesLength
					: Math.floor(currentPage % (messagesLength / limitation)) * limitation;
			const startIndex = endIndex - limitation;

			paginatedMessages = Array.from(messages.values()).slice(
				startIndex,
				endIndex
			);
		}

		const response: TMessage[] = [];

		paginatedMessages.forEach((msg) => {
			const message = formMessage(msg);

			response.push(message as any as TMessage);
		});

		return res.status(200).json({
			status: "success",
			results: response.length,
			data: response,
		});
	});

const sendDMMessage = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const message = req.body.message;
		const userId = req.params.chat;

		await client.users.send(userId, message).catch((err) => {
			res.status(400).json({
				data: "Couldn't send a message!",
			});
			throw new AppError("Couldn't send a message!", 400);
		});

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
