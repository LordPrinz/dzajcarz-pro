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

  async updateServicePrivileges(
    guildId: string,
    service: string,
    disabled: 'disabled' | 'enabled' | 'no-action',
    channelsToUpdate: { id: string; action: 'add' | 'remove' }[] | null,
  ) {
    const cacheKeyEnabledServices = `enabledServices:${guildId}`;
    const cacheKeyDisabledServices = `disabledServices:${guildId}`;
    const serviceDisabledChannels = `serviceDisabledChannels:${guildId}:${service}`;

    if (disabled === 'disabled') {
      const prevValue = JSON.parse((await this.getFromCache(cacheKeyEnabledServices)) || '[]');
      this.setToCache(cacheKeyEnabledServices, JSON.stringify(prevValue.filter((serviceId: string) => serviceId !== service)));

      const prevValueDisabled = JSON.parse((await this.getFromCache(cacheKeyDisabledServices)) || '[]');
      this.setToCache(cacheKeyDisabledServices, JSON.stringify([...prevValueDisabled, service]));
    }

    if (disabled === 'enabled') {
      const prevValue = JSON.parse((await this.getFromCache(cacheKeyEnabledServices)) || '[]');
      this.setToCache(cacheKeyEnabledServices, JSON.stringify([...prevValue, service]));

      const prevValueDisabled = JSON.parse((await this.getFromCache(cacheKeyDisabledServices)) || '[]');
      this.setToCache(cacheKeyDisabledServices, JSON.stringify(prevValueDisabled.filter((serviceId: string) => serviceId !== service)));
    }

    if (channelsToUpdate) {
      let value = JSON.parse((await this.getFromCache(serviceDisabledChannels)) || '[]');

      for (const channel of channelsToUpdate) {
        if (channel.action === 'add') {
          if (!value.includes(channel.id)) {
            value.push(channel.id);
          }
        } else if (channel.action === 'remove') {
          value = value.filter((id: string) => id !== channel.id);
        }
      }

      this.setToCache(serviceDisabledChannels, JSON.stringify(value));
    }

    if (disabled && disabled !== 'no-action') {
      const isDisabled = disabled === 'disabled';
      await sql`
        INSERT INTO serverservices (serverid, serviceid, disabled)
        VALUES (${guildId}, ${service}, ${isDisabled})
        ON CONFLICT (serverid, serviceid) 
        DO UPDATE SET disabled = EXCLUDED.disabled;
      `;
    }

    if (channelsToUpdate) {
      for (const channel of channelsToUpdate) {
        if (channel.action === 'add') {
          await sql`
            INSERT INTO serviceblockchannels (serverid, serviceid, channelid)
            VALUES (${guildId}, ${service}, ${channel.id})
            ON CONFLICT DO NOTHING;
          `;
        } else if (channel.action === 'remove') {
          await sql`
            DELETE FROM serviceblockchannels
            WHERE serverid = ${guildId} AND serviceid = ${service} AND channelid = ${channel.id};
          `;
        }
      }
    }
  }

  async getServicePrivileges(guildId: string, service: string): Promise<[boolean, string[]]> {
    const cacheDisabledChannelsKey = `serviceDisabledChannels:${guildId}:${service}`;
    const cacheDisabledServicesKey = `disabledServices:${guildId}`;

    const disabledServicesCache = await this.getFromCache(cacheDisabledServicesKey);
    let isDisabled = false;

    if (disabledServicesCache) {
      const disabledServices = JSON.parse(disabledServicesCache) as string[];
      isDisabled = disabledServices.includes(service);
    }

    const cachedDisabledChannels = await this.getFromCache(cacheDisabledChannelsKey);
    let disabledChannels: string[] = [];

    if (cachedDisabledChannels) {
      disabledChannels = JSON.parse(cachedDisabledChannels) as string[];
    }

    if (disabledServicesCache && cachedDisabledChannels) {
      return [isDisabled, disabledChannels];
    }

    const res = await sql`
      SELECT serverservices.disabled AS is_disabled, serviceblockchannels.channelid AS channel_id
      FROM serverservices
      LEFT JOIN serviceblockchannels
      ON serverservices.serviceid = serviceblockchannels.serviceid
      AND serverservices.serverid = serviceblockchannels.serverid
      WHERE serverservices.serverid = ${guildId}
      AND serverservices.serviceid = ${service}
    `;

    if (!res || res.length === 0) {
      const defaultValue: [boolean, string[]] = [false, []];
      await this.setToCache(cacheDisabledChannelsKey, JSON.stringify(defaultValue));
      return defaultValue;
    }

    isDisabled = res[0].is_disabled ?? false;
    disabledChannels = res.map((row: { channel_id: string | null }) => row.channel_id).filter(Boolean) as string[];

    const result: [boolean, string[]] = [isDisabled, disabledChannels];

    await this.setToCache(cacheDisabledChannelsKey, JSON.stringify(disabledChannels));

    if (!disabledServicesCache) {
      const allDisabledServices = await sql`
        SELECT serviceid FROM serverservices
        WHERE serverid = ${guildId} AND disabled = true
      `;
      const disabledServiceList = allDisabledServices.map((row: { serviceid: string }) => row.serviceid);
      await this.setToCache(cacheDisabledServicesKey, JSON.stringify(disabledServiceList));
    }

    return result;
  }

  async getDisabledServices(guildId: string): Promise<string[]> {
    const cacheKey = `disabledServices:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);
    if (cachedValue) {
      return JSON.parse(cachedValue);
    }

    const res = await sql`
        SELECT serviceid
        FROM serverservices
        WHERE serverid = ${guildId}
        AND disabled = true
      `;

    const disabledServices = res.map((row: { serviceid: string }) => row.serviceid);

    await this.setToCache(cacheKey, JSON.stringify(disabledServices));

    return disabledServices;
  }

  async getEnabledServices(guildId: string): Promise<string[]> {
    const cacheKey = `enabledServices:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue) {
      return JSON.parse(cachedValue);
    }

    const res = await sql`
        SELECT serviceid
        FROM serverservices
        WHERE serverid = ${guildId}
        AND disabled = false`;

    const enabledServices = res.map((row: { serviceid: string }) => row.serviceid);
    await this.setToCache(cacheKey, JSON.stringify(enabledServices));

    return enabledServices;
  }

  async disableService(guildId: string, service: string) {
    await this.updateServicePrivileges(guildId, service, 'disabled', null);
  }

  async enableService(guildId: string, service: string) {
    await this.updateServicePrivileges(guildId, service, 'enabled', null);
  }

  async disableServiceChannel(guildId: string, service: string, channelId: string) {
    await this.updateServicePrivileges(guildId, service, 'no-action', [{ id: channelId, action: 'add' }]);
  }

  async enableServiceChannel(guildId: string, service: string, channelId: string) {
    await this.updateServicePrivileges(guildId, service, 'no-action', [{ id: channelId, action: 'remove' }]);
  }
}

export const database = new DzajDB();
