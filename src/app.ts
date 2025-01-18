import { DzajCommander } from "@/core/commander";
import { botOwners, intents, partials, testServers } from "config/bot";
import { Client } from "discord.js";
import { join } from "node:path";

const client = new Client({
    intents,
    partials,
});

export const dzajcommander = new DzajCommander({
    client,
    prefix: "!",
    featuresDir: join(__dirname, "features"),
    commandsDir: join(__dirname, "commands"),
    eventsDir: join(__dirname, "events"),
    redisUrl: process.env.REDIS_URL,
    postgreUrl: process.env.POSTGRE_URL,
    ownersIds: botOwners,
    testServers: testServers
});