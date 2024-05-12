import { configCustomAlias } from "./conf/customAlias";
configCustomAlias();

import { config } from "dotenv";
import { client as botClient } from "@/app";
import mongoose from "mongoose";

config();

const { NODE_ENV } = process.env;

const DB = process.env.MONGO_URI;

if (!DB) {
	throw new Error("MongoDB URI is missing");
}

mongoose.connect(DB).then(() => {
	console.log("DB connected successfully!");
});

if (NODE_ENV === "development") {
	botClient.login(process.env.DEV_TOKEN);
}
if (NODE_ENV === "production") {
	botClient.login(process.env.PROD_TOKEN);
}
