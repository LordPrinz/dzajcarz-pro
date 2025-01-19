import type { Client } from 'discord.js';
import { estabilishDBConnection, registerCommands, registerEvents, registerFeatures } from './services';
import type { DzajCommand } from './services';
import type postgres from 'postgres';
import { createClient, type RedisClientType } from 'redis';

type DzajCommanderOptions = {
  client: Client;
  commandsDir: string;
  eventsDir: string;
  prefix: string;
  ownersIds: string[];
  featuresDir: string;
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
  private cacheClient: RedisClientType | null = null;
  private DBClient: postgres.Sql | null = null;

  constructor({ client, commandsDir, eventsDir, prefix, ownersIds, featuresDir, postgreUrl, redisUrl }: DzajCommanderOptions) {
    this.client = client;
    this.commandsDir = commandsDir;
    this.eventsDir = eventsDir;
    this.prefix = prefix;
    this.ownersIds = ownersIds;
    this.featuresDir = featuresDir;

    this.client.once('ready', async () => {
      console.log('Logged in as', this.client.user?.displayName);
      await this.init({ postgreUrl, redisUrl });
    });
  }

  public handleLogin() {
    if (process.env.NODE_ENV === 'production') {
      this.client.login(process.env.BOT_PRODUCTION_TOKEN);
    }

    if (process.env.NODE_ENV === 'development') {
      this.client.login(process.env.BOT_DEVELOPMENT_TOKEN);
    }
  }

  private async init({ postgreUrl, redisUrl }: { postgreUrl: string; redisUrl: string }) {
    this.DBClient = await estabilishDBConnection(postgreUrl);
    this.cacheClient = createClient({ url: redisUrl });
    this.cacheClient.on('error', (err) => console.error('Redis Client Error', err)).connect();

    await registerEvents(this, this.eventsDir);
    await registerFeatures(this, this.featuresDir);
    await registerCommands(this, this.commandsDir, this.prefix);
  }

  public getClient() {
    return this.client;
  }

  public getPrefix() {
    return this.prefix;
  }

  public getOwnersIds() {
    return this.ownersIds;
  }

  public getCacheClient() {
    return this.cacheClient;
  }

  public getDBClient() {
    return this.DBClient;
  }

  public setClient(client: Client) {
    this.client = client;
  }

  private terminate() {
    this.client.destroy();
  }
}

export type { DzajCommand };
