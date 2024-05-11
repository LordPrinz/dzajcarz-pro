import { config } from "dotenv";
import { client as botClient } from "./bot";

config();

const { NODE_ENV } = process.env;

if (NODE_ENV === "development") {
	botClient.login(process.env.DEV_TOKEN);
}
if (NODE_ENV === "production") {
	botClient.login(process.env.PROD_TOKEN);
}
