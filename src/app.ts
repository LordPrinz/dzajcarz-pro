import dotenv from "dotenv";
import Logger from "./utils/debug/Logger";
import client from "./bot";
import dzajcordServer from "./server";

dotenv.config();

const botLogger = new Logger("dzajcarz");
const serverLogger = new Logger("dzajserver");

if (process.env.NODE_ENV === "development") {
	client.login(process.env.DEV_TOKEN);
}

if (process.env.NODE_ENV === "production") {
	client.login(process.env.PROD_TOKEN);
}

process.on("uncaughtException", (err) => {
	botLogger.saveLog(`${err.name}${err.message}`, "error");
});

process.on("warning", (warn) => {
	botLogger.saveLog(`${warn.name}${warn.message}`, "warn");
});

const port = process.env.PCHPORT || 4761;

const dzajServer = dzajcordServer.listen(port, () => {
	serverLogger.saveLog(`App running on port ${port}`, "info");
});

process.on("unhandledRejection", (err: Error) => {
	botLogger.saveLog(`${err.name}${err.message}`, "error");
});

process.on("SIGTERM", () => {
	botLogger.saveLog("SIGTERM RECEIVED. Shutting down gracefully", "info");
	client.destroy();
	dzajServer.close(() => {
		serverLogger.saveLog("CHANNEL LISTENER TERMINATED!", "info");
	});

	process.exit(2);
});
