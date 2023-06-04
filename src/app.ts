import dotenv from "dotenv";
import server from "./server";
import Logger from "./utils/debug/Logger";
import client from "./bot";
import setupServer from "./server";

dotenv.config();

const logger = new Logger();

if (process.env.NODE_ENV === "development") {
	client.login(process.env.DEV_TOKEN);
}

if (process.env.NODE_ENV === "production") {
	client.login(process.env.PROD_TOKEN);
}

process.on("uncaughtException", (err) => {
	logger.saveLog(`${err.name}${err.message}`, "error");
});

process.on("warning", (warn) => {
	logger.saveLog(`${warn.name}${warn.message}`, "warn");
});

const port = process.env.PCHPORT || 4761;

const dzajServer = setupServer(client).listen(port, () => {
	logger.saveLog(`App running on port ${port}`, "info");
});

process.on("unhandledRejection", (err: Error) => {
	logger.saveLog(`${err.name}${err.message}`, "error");
});

process.on("SIGTERM", () => {
	logger.saveLog("SIGTERM RECEIVED. Shutting down gracefully", "info");
	dzajServer.close(() => {
		logger.saveLog("PRIVATE CHANNEL LISTENER TERMINATED!", "info");
	});
});
