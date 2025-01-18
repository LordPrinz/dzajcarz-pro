import type { Client } from "discord.js";
import { estabilishDBConnection, registerCommands, registerEvents } from "./services";
import { registerFearures } from "./services/registerFeatures";

type DzajCommanderOptions = {
    client: Client
    commandsDir: string;
    eventsDir: string;
    prefix: string;
    ownersIds: string[];
    featuresDir: string;
    testServers: string[];
    postgreUrl: string;
    redisUrl: string;
};

export class DzajCommander {
    private client: Client;
    private commandsDir: string;
    private eventsDir: string;
    private prefix: string;
    private ownersIds: string[];
    private featuresDir: string;
    private testServers: string[];
    private cacheConnection: unknown;
    private DBConnection: unknown;

    constructor({ client, commandsDir, eventsDir, prefix, ownersIds, featuresDir, testServers, postgreUrl, redisUrl}: DzajCommanderOptions) {
        this.client = client;
        this.commandsDir = commandsDir;
        this.eventsDir = eventsDir;
        this.prefix = prefix;
        this.ownersIds = ownersIds;
        this.featuresDir = featuresDir;
        this.testServers = testServers;

        this.client.once("ready", () => {
            console.log('Logged in as', this.client.user?.displayName);
            this.init({postgreUrl, redisUrl});
        });
    }

    public handleLogin() {
        if(process.env.NODE_ENV === "production") {
            this.client.login(process.env.BOT_PRODUCTION_TOKEN);
        };

        if(process.env.NODE_ENV === "development") {
            this.client.login(process.env.BOT_DEVELOPMENT_TOKEN);
        };
    };

    private async init({postgreUrl, redisUrl}: {postgreUrl: string, redisUrl: string}) {
        const {cacheConnection, DBConnection} = await estabilishDBConnection({postgreUrl, redisUrl});
        this.cacheConnection = cacheConnection;
        this.DBConnection = DBConnection;
        
        await registerEvents(this.client, this.eventsDir);
        await registerFearures(this.client, this.featuresDir);
        await registerCommands(this.client, this.commandsDir, this.prefix);
    }

    private getClient() {
        return this.client;
    }

    private setClient(client: Client) {
        this.client = client;
    }

    private terminate() {
        this.client.destroy();
    };
}