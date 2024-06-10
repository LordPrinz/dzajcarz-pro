import { getPartyAreas } from "@/db/partyArea";
import { redisClient } from "@/lib/redisClient";
import { type Client } from "discord.js";

export const syncVCRedis = async (client: Client) => {
	// console.log(client);
};

export const syncPartyRedisMongo = async () => {
	const partyArea = await getPartyAreas();

	await redisClient.set("partyArea", JSON.stringify(partyArea));
};
