import dotenv from "dotenv";
import privateChatServer from "./privateChatServer";
import { createErrorLog } from "./utilities/loger";

dotenv.config();

process.on("uncaughtException", (err) => {
	console.log("UNCAUGHT EXCEPTION! Shutting down...");
	console.log(err.name, err.message);
	createErrorLog(err);
});

const port = process.env.PCHPORT || 4761;

const PCHServer = privateChatServer.listen(port, () => {
	console.log(`App running on port ${port}`);
});

process.on("unhandledRejection", (err: Error) => {
	console.log("UNHANDLED REJECTION!");
	console.log(err.name, err.message);
	createErrorLog(err);
});

process.on("SIGTERM", () => {
	console.log("SIGTERM RECEIVED. Shutting down gracefully");
	PCHServer.close(() => {
		console.log("Process terminated!");
	});
});
