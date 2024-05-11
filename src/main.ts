import { config } from "dotenv";
import { clinet as botClient } from "./bot";
const { NODE_ENV } = process.env;

config();

if (NODE_ENV === "development") {
	botClient.login(process.env.DEV_TOKEN);
}
if (NODE_ENV === "production") {
	botClient.login(process.env.PROD_TOKEN);
}
