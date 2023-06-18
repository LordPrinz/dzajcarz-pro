import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoSanitize from "express-mongo-sanitize";
import compression from "compression";
import http from "http";

import AppError from "../utils/server/AppError";
import globalErrorHandler from "./controllers/errorController";
import userRouter from "./routes/userRouter";
import messageRouter from "./routes/messageRouter";
import channelRouter from "./routes/channelRouter";
import serverRouter from "./routes/serverRouter";

// Express Server

const app = express();
const server = http.createServer(app);

app.enable("trust proxy");

app.use(express.json());

app.use(cors());

if (process.env.NODE_ENV === "development") {
	app.use(morgan("dev"));
}

app.use(mongoSanitize());

app.use(compression());

app.use((req, res, next) => {
	(req as any).requestTime = new Date().toISOString();
	next();
});

app.use("/api/v1/users", userRouter);
app.use("/api/v1/channels", channelRouter);
app.use("/api/v1/messages", messageRouter);
app.use("/api/v1/servers", serverRouter);

app.get("/favicon.ico", (req, res) => {
	res.status(204).end();
});

app.all("*", async (req, res, next) => {
	new AppError(`Can't find ${req.originalUrl} on this server!`, 404);
});

app.use(globalErrorHandler);

export default server;
