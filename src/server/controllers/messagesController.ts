import { NextFunction, Request, Response } from "express";
import MessageModel from "../../bot/models/messageModel";
import catchAsync from "../../utils/server/catchAsync";
import factory from "./handleFactory";
import client from "../../bot";
import { TextChannel } from "discord.js";

const getAllMessages = async () =>
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

		const fetchedMessages = await channel.messages.fetch({ limit: 5 });
		console.log(fetchedMessages);

		res.end();
	});
export default {
	getAllDMMessages: factory.getAll(MessageModel),
	getDMMessages: factory.getAll(MessageModel),
	getAllMessages,
};
