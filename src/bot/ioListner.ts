import { Client } from "discord.js";
import { Server } from "socket.io";
import server from "../server";
import {
	messageCreateHandler,
	messageDeleteHandler,
	messageUpdateHandler,
} from "./controllers/ioController";

const setupChatListener = (client: Client) => {
	const io = new Server(server);

	let socket = null;

	io.on("connection", (connectedSocket) => {
		socket = connectedSocket;
	});

	io.on("connect_failed", () => {
		throw new Error("Web socket connection failed");
	});

	client.on("messageCreate", messageCreateHandler.bind(null, socket));
	client.on("messageUpdate", messageUpdateHandler.bind(null, socket));
	client.on("messageDelete", messageDeleteHandler.bind(null, socket));
};

export default setupChatListener;
