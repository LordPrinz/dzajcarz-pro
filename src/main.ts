import { configCustomAlias } from "./conf/customAlias";
configCustomAlias();

import { config } from "dotenv";
import { client as botClient } from "@/app";
import mongoose from "mongoose";
import { configMongoDB } from "./lib/mongoDB";

config();

const { NODE_ENV } = process.env;

configMongoDB();

if (NODE_ENV === "development") {
	botClient.login(process.env.DEV_TOKEN);
}
if (NODE_ENV === "production") {
	botClient.login(process.env.PROD_TOKEN);
}
