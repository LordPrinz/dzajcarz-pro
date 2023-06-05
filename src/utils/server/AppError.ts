import Logger from "../debug/Logger";

class AppError extends Error {
	statusCode: number;
	status: "fail" | "error";
	isOperational: boolean;
	constructor(message: string, statusCode: number) {
		const logger = new Logger("dzajserver");

		super(message);

		this.statusCode = statusCode;
		this.status = statusCode.toString().startsWith("4") ? "fail" : "error";
		this.isOperational = true;

		Error.captureStackTrace(this, this.constructor);

		logger.saveLog(`Chat Server -> ${message}`, "error");
	}
}

export default AppError;
