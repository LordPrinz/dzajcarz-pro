import dotenv from "dotenv";
import privateChatServer from "./privateChatServer";
import { createLog } from "./utilities/errorLoger";
// tdd
dotenv.config();

process.on("uncaughtException", (err) => {
	console.log("UNCAUGHT EXCEPTION! Shutting down...");
	console.log(err.name, err.message);
	createLog(err);

	process.exit(1);
});

const port = process.env.PCHPORT || 4761;

const PCHServer = privateChatServer.listen(port, () => {
	console.log(`App running on port ${port}`);
});

process.on("unhandledRejection", (err: Error) => {
	console.log("UNHANDLED REJECTION! Shutting down...");
	console.log(err.name, err.message);
	createLog(err);
	PCHServer.close(() => {
		process.exit(1);
	});
});

process.on("SIGTERM", () => {
	console.log("SIGTERM RECEIVED. Shutting down gracefully");
	PCHServer.close(() => {
		console.log("Process terminated!");
	});
});
