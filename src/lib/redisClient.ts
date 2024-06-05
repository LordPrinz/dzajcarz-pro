import redis from "redis";

export const redisClient = redis.createClient();

redisClient.on("error", (error) => {
	console.error(error);
});

redisClient.on("connect", () => {
	console.log("Connected to Redis");
});
