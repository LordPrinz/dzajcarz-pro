import dotenv from "dotenv";
import privateChatServer from "./privateChatServer";
import Logger from "./utils/debug/Logger";

dotenv.config();

const logger = new Logger();

process.on("uncaughtException", (err) => {
	logger.saveLog(`${err.name }${err.message}`, "error");
});

process.on("warning", (warn) => {
  logger.saveLog(`${warn.name }${warn.message}`, "warn");
})

const port = process.env.PCHPORT || 4761;

const PCHServer = privateChatServer.listen(port, () => {
  logger.saveLog(`App running on port ${port}`,  "info");
});

process.on("unhandledRejection", (err: Error) => {
	logger.saveLog(`${err.name }${err.message}`, "error");
});

process.on("SIGTERM", () => {
  logger.saveLog("SIGTERM RECEIVED. Shutting down gracefully", "info");
	PCHServer.close(() => {
    logger.saveLog("PRIVATE CHANNEL LISTENER TERMINATED!", "info");
	});
});

