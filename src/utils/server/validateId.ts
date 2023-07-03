import { Response } from "express";

export default (id: string) => id.match(/^[0-9a-fA-F]{18}$/);
export const sendWrongIdError = (res: Response) => {
	res.status(422).json({
		status: "fail",
		results: 0,
		data: "Wrong ID",
	});
};

export const sendEmptyMessages = (res: Response) => {
	res.status(200).json({
		status: "success",
		results: 0,
		data: [],
	});
};
