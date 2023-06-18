import { NextFunction, Request, Response } from "express";
import catchAsync from "../../utils/server/catchAsync";
import ServerModel from "../../bot/models/serverModel";
import client from "../../bot";
import { TextChannel } from "discord.js";

type responseChannel = {
	id: string;
	type: string;
	name: string;
	nsfw: boolean;
};

const getAllChannels = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const serverId = req.params.id;

		const server = client.guilds.cache.find((g) => g.id === serverId);

		if (!server) {
			return res.status(422).json({
				status: "fail",
				results: 0,
				data: "Wrong ID",
			});
		}

		const channels = [...(await server.channels.fetch()).values()]; // server channels array

		const response: responseChannel[] = [];

		channels.forEach((channel) => {
			response.push({
				id: channel?.id!,
				name: channel?.name!,
				type: channel?.type!,
				nsfw: !!(channel as TextChannel)?.nsfw,
			});
		});

		res.status(200).json({
			status: "success",
			results: response.length,
			data: response,
		});
	});

const getChannel = () =>
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

		const channel = server?.channels.cache.find((ch) => ch.id === channelId);

		if (!channel) {
			return res.status(422).json({
				status: "fail",
				results: 0,
				data: "Wrong ID",
			});
		}

		const response = {
			id: channel?.id!,
			name: channel?.name!,
			type: channel?.type!,
			nsfw: !!(channel as TextChannel)?.nsfw,
		};

		res.status(200).json({
			status: "success",
			data: response,
		});
	});

export default {
	getAllChannels: getAllChannels(),
	getChannel: getChannel(),
};
