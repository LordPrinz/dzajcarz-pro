import type { Client } from 'discord.js';
import { buildDB, registerCommands, registerEvents, registerFeatures } from './services';
import type { DzajCommand } from './services';
import { createClient, type RedisClientType } from 'redis';

type DzajCommanderOptions = {
  client: Client;
  commandsDir: string;
  eventsDir: string;
  prefix: string;
  ownersIds: string[];
  featuresDir: string;
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

  constructor({ client, commandsDir, eventsDir, prefix, ownersIds, featuresDir, redisUrl }: DzajCommanderOptions) {
    this.client = client;
    this.commandsDir = commandsDir;
    this.eventsDir = eventsDir;
    this.prefix = prefix;
    this.ownersIds = ownersIds;
    this.featuresDir = featuresDir;

    this.client.once('ready', async () => {
      console.log('Logged in as', this.client.user?.displayName);
      await this.init({ redisUrl });
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

  private async init({ redisUrl }: { redisUrl: string }) {
    this.cacheClient = createClient({ url: redisUrl });
    this.cacheClient
      .on('error', (err) => console.error('Redis Client Error', err))
      .connect()
      .then(() => console.log('Cache client connected'));

    await buildDB();
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

  public setClient(client: Client) {
    this.client = client;
  }

  public terminate() {
    this.client.destroy();
    this.cacheClient?.quit();
  }
}

export type { DzajCommand };
