import { createClient } from "redis";

export const redisClient = createClient({
	url: "redis://127.0.0.1:6379",
});

redisClient.on("error", (error) => {
	console.error(error);
});

redisClient.on("connect", () => {
	console.log("Connected to Redis");
});

export const configureRedis = async () => {
	try {
		await redisClient.connect();
	} catch (error) {
		console.error("Failed to connect to Redis:", error);
	}
};
