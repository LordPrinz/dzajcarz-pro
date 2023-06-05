import AppError from "../../utils/server/AppError";
import ErrorStack from "../models/errorModel";
import type { Response, Request } from "express";
import { errorType } from "../../types/runtimeTypes";
const saveError = async (err: errorType) => {
	const newError = await ErrorStack.create({
		status: err.status,
		error: err,
		message: err.message,
		stack: err.stack,
	});

	return newError.id;
};

const handleCastErrorDB = (err: errorType) => {
	const message = `Invalid ${err.path}: ${err.value}.`;
	return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err: any) => {
	const value = err.errmsg.match(/(["'])(\\?.)*?\1/)[0];
	const message = `Duplicate field value: ${value}. Please use another value!`;
	return new AppError(message, 400);
};

const handleValidationErrorDB = (err: errorType) => {
	const errors = Object.values(err.errors).map((el) => el.message);

	const message = `Invalid input data. ${errors.join(". ")}`;
	return new AppError(message, 400);
};

const sendErrorDev = async (err: errorType, req: Request, res: Response) => {
	if (req.originalUrl.startsWith("/api")) {
		return res.status(err.statusCode).json({
			status: err.status,
			error: err,
			message: err.message,
			stack: err.stack,
		});
	}
};

const sendErrorProd = async (err: errorType, req: Request, res: Response) => {
	if (req.originalUrl.startsWith("/api")) {
		if (err.isOperational) {
			const errorId = await saveError(err);
			return res.status(err.statusCode).json({
				status: err.status,
				message: `${err.message} (${errorId})`,
			});
		}
	}
	console.error("ERROR 💥", err);
	const errorId = await saveError(err);
	return res.status(500).json({
		status: "error",
		message: `Something went wrong! (${errorId})`,
	});
};

const errorController = (err: any, req: Request, res: Response) => {
	err.statusCode = err.statusCode || 500;
	err.status = err.status || "error";

	if (process.env.NODE_ENV === "development") {
		sendErrorDev(err, req, res);
	} else if (process.env.NODE_ENV === "production") {
		let error = { ...err };
		error.message = err.message;

		if (error.name === "CastError") error = handleCastErrorDB(error);
		if (error.code === 11000) error = handleDuplicateFieldsDB(error);
		if (error.name === "ValidationError")
			error = handleValidationErrorDB(error);

		sendErrorProd(error, req, res);
	}
};

export default errorController;
