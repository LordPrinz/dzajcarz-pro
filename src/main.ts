import { configCustomAlias } from "./conf/customAlias";
configCustomAlias();

import { config } from "dotenv";
import { client as botClient } from "@/app";
import { configMongoDB } from "./lib/mongoDB";

config();

const { NODE_ENV } = process.env;

configMongoDB();

if (NODE_ENV === "development") {
	botClient.login(process.env.DEV_TOKEN);
}

if (NODE_ENV === "production") {
	botClient.login(process.env.PROD_TOKEN);

	process.on("unhandledRejection", (reason, promise) => {
		console.error("Unhandled Rejection at:", promise, "reason:", reason);
	});

	process.on("uncaughtException", (error) => {
		console.error("Uncaught Exception thrown", error);
	});

	process.on("SIGINT", async () => {
		await botClient.destroy();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await botClient.destroy();
		process.exit(0);
	});

	process.on("exit", async () => {
		await botClient.destroy();
		process.exit(0);
	});
}
