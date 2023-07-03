import { NextFunction, Response, Request } from "express";
import catchAsync from "../../utils/server/catchAsync";
import client from "../../bot";

type Emoji = {
	id: string;
	name: string;
	url: string;
};

const getAllEmoji = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const guilds = client.guilds.cache;

		const emojis: Emoji[] = [];

		for (const guild of guilds.values()) {
			const guildEmojis = await guild.emojis.fetch();
			guildEmojis.map((emoji) => {
				emojis.push({
					id: emoji.identifier,
					name: emoji.name as string,
					url: emoji.url,
				});
			});
		}

		res.status(200).json({
			status: "success",
			results: emojis.length,
			data: emojis,
		});
	});
const getEmoji = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const emoji = client.emojis.cache.find(
			(emoji) => emoji.identifier === req.params.id
		);

		const transformedEmoji = {
			id: emoji?.identifier,
			name: emoji?.name,
			url: emoji?.url,
		};

		res.status(200).json({
			status: "success",
			results: 1,
			data: transformedEmoji,
		});
	});

export default {
	getAllEmojis: getAllEmoji(),
	getEmoji: getEmoji(),
};
