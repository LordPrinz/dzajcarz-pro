import { NextFunction, Response, Request } from "express";
import catchAsync from "../../utils/server/catchAsync";
import client from "../../bot";

const getAllEmoji = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {
		const emojis = client.emojis;
		console.log(emojis);
		res.end();
	});
const getEmoji = () =>
	catchAsync(async (req: Request, res: Response, next: NextFunction) => {});

export default {
	getAllEmojis: getAllEmoji(),
	getEmoji: getEmoji(),
};
