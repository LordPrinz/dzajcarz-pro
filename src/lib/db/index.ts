import { dzajcarz } from '@/app';
import { sql } from 'bun';

class HybridDB {
  private cache;

  constructor() {
    this.cache = dzajcarz.getCacheClient()!;
  }

  protected async getFromCache(key: string): Promise<string | null> {
    return this.cache.get(key);
  }

  protected async setToCache(key: string, value: string) {
    return this.cache.set(key, value);
  }

  protected async deleteFromCache(key: string) {
    return this.cache.del(key);
  }
}

class DzajDB extends HybridDB {
  constructor() {
    super();
  }

  async get(key: string) {
    return this.getFromCache(key);
  }

  async set(key: string, value: string) {
    return this.setToCache(key, value);
  }

  async delete(key: string) {
    return this.deleteFromCache(key);
  }

  async updateServicePrivileges(guildId: string, service: string, disabled: boolean, disabledChannel: string) {
    const cacheKey = `servicePrivileges:${guildId}:${service}`;

    await this.deleteFromCache(cacheKey);

    await sql`
        INSERT INTO serverservices (serverid, serviceid, disabled)
        VALUES (${guildId}, ${service}, ${disabled})
        ON DUPLICATE KEY UPDATE disabled = ${disabled}
      `;

    if (disabledChannel) {
      await sql`
          INSERT INTO serviceblockchannels (serverid, serviceid, channelid)
          VALUES (${guildId}, ${service}, ${disabledChannel})
        `;
    }
  }

  async getServicePrivileges(guildId: string, service: string): Promise<[boolean, string[]]> {
    const cacheKey = `servicePrivileges:${guildId}:${service}`;

    const cachedValue = await this.getFromCache(cacheKey);
    if (cachedValue) {
      return JSON.parse(cachedValue);
    }

    const res = await sql`
        SELECT disabled, channelid
        FROM serverservices
        LEFT JOIN serviceblockchannels
        ON serverservices.serviceid = serviceblockchannels.serviceid
        AND serverservices.serverid = serviceblockchannels.serverid
        WHERE serverservices.serverid = ${guildId}
        AND serverservices.serviceid = ${service}
      `;

    if (!res || res.length === 0) {
      const defaultValue: [boolean, string[]] = [false, []];
      await this.setToCache(cacheKey, JSON.stringify(defaultValue));
      return defaultValue;
    }

    const isDisabled = res[0].disabled;
    const disabledChannels = res.map((row: { channelid: string }) => row.channelid).filter(Boolean);

    const result: [boolean, string[]] = [isDisabled, disabledChannels];

    await this.setToCache(cacheKey, JSON.stringify(result));

    return result;
  }
}

export const database = new DzajDB();
