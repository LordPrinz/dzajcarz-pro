import { redisClient } from "@/lib/redisClient";

export const getElements = async <T>(key: string): Promise<T> => {
	return JSON.parse(await redisClient.get(key));
};

export const setElements = async <T>(key: string, value: T) =>
	await redisClient.set(key, JSON.stringify(value));

export const deleteElements = async (key: string) => await redisClient.del(key);
