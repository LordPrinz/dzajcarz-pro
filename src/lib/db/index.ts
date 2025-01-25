import { dzajcarz } from '@/app';
import { sql } from 'bun';

export type PartyArea = {
  categoryId: string;
  serverId: string;
  generationTemplate: string;
  commandChannelId: string | null;
  splitChannelId: string;
};

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

  async saveSplitChannelToCache(guildId: string, splitChannelId: string) {
    const cacheKey = `splitChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      const newCacheValue = [splitChannelId];
      await this.setToCache(cacheKey, JSON.stringify(newCacheValue));
    } else {
      const splitChannels = JSON.parse(cachedValue || '[]');
      if (!splitChannels.includes(splitChannelId)) {
        splitChannels.push(splitChannelId);
        await this.setToCache(cacheKey, JSON.stringify(splitChannels));
      }
    }
  }

  async deleteSplitChannelFromCache(guildId: string, splitChannelId: string) {
    const cacheKey = `splitChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      return;
    }

    const splitChannels = JSON.parse(cachedValue || '[]');
    const newSplitChannels = splitChannels.filter((id: string) => id !== splitChannelId);

    await this.setToCache(cacheKey, JSON.stringify(newSplitChannels));
  }

  async isSplitChannel(guildId: string, splitChannelId: string) {
    const cacheKey = `splitChannel:${guildId}`;
    const cachedValue = await this.getFromCache(cacheKey);

    return cachedValue?.includes(splitChannelId);
  }

  async savePartyArea({ serverId, categoryId, generationTemplate, commandChannelId, splitChannelId }: PartyArea) {
    const cacheKey = `partyArea:${serverId}:${categoryId}`;

    await this.setToCache(cacheKey, JSON.stringify({ categoryId, generationTemplate, commandChannelId, splitChannelId }));

    await sql`
      INSERT INTO partyarea (categoryid, serverid, generationtemplate, commandchannelid, splitchannelid)
      VALUES (${categoryId}, ${serverId}, ${generationTemplate}, ${commandChannelId}, ${splitChannelId})
      ON CONFLICT (categoryid, serverid)
      DO UPDATE SET generationtemplate = EXCLUDED.generationtemplate, commandchannelid = EXCLUDED.commandchannelid, splitchannelid = EXCLUDED.splitchannelid;
    `;

    await this.savePartyChannel(serverId, categoryId);
    if (commandChannelId) {
      await this.saveCommandChannel(serverId, commandChannelId);
    }

    await this.saveSplitChannelToCache(serverId, splitChannelId);
  }

  async getPartyArea(guildId: string, categoryId: string): Promise<PartyArea | null> {
    const cacheKey = `partyArea:${guildId}:${categoryId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue) {
      return JSON.parse(cachedValue);
    }

    const res = await sql`
      SELECT categoryid, generationtemplate, commandchannelid, splitchannelid
      FROM partyarea
      WHERE serverid = ${guildId}
      AND categoryid = ${categoryId}
    `;

    if (!res || res.length === 0) {
      return null;
    }

    const partyArea = res[0];

    await this.setToCache(cacheKey, JSON.stringify(partyArea));

    return partyArea;
  }

  async addCustomVoiceChannel(guildId: string, channelId: string) {
    const cacheKey = `customVoiceChannels:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      const newCacheValue = [channelId];
      await this.setToCache(cacheKey, JSON.stringify(newCacheValue));
    } else {
      const customVoiceChannels = JSON.parse(cachedValue || '[]');
      if (!customVoiceChannels.includes(channelId)) {
        customVoiceChannels.push(channelId);
        await this.setToCache(cacheKey, JSON.stringify(customVoiceChannels));
      }
    }
  }

  async getCustomVoiceChannels(guildId: string) {
    const cacheKey = `customVoiceChannels:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    return JSON.parse(cachedValue || '[]');
  }

  async deleteCustomVoiceChannel(guildId: string, voiceChannelId: string) {
    const cacheKey = `customVoiceChannels:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      return;
    }

    const customVoiceChannels = JSON.parse(cachedValue || '[]');
    const newCustomVoiceChannels = customVoiceChannels.filter((id: string) => id !== voiceChannelId);

    await this.setToCache(cacheKey, JSON.stringify(newCustomVoiceChannels));
  }

  async deleteCustomVoiceChannels(guildId: string) {
    const cacheKey = `customVoiceChannels:${guildId}`;
    await this.deleteFromCache(cacheKey);
  }

  async deletePartyArea(guildId: string, splitChannelId: string, categoryId: string) {
    const cacheKey = `partyArea:${guildId}:${categoryId}`;
    const cachedValue = JSON.parse((await this.getFromCache(cacheKey)) || '[]');
    await this.deleteSplitChannelFromCache(guildId, splitChannelId);
    await this.deleteCommandChannel(guildId, cachedValue.commandChannelId);
    await this.deletePartyChannel(guildId, categoryId);
    await this.deleteFromCache(cacheKey);
    await this.deleteCustomVoiceChannels(guildId);

    await sql`
      DELETE FROM partyarea
      WHERE serverid = ${guildId}
      AND splitchannelid = ${splitChannelId}
    `;
  }

  async savePartyChannel(guildId: string, channelId: string) {
    const cacheKey = `partyChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      const newCacheValue = [channelId];
      await this.setToCache(cacheKey, JSON.stringify(newCacheValue));
    } else {
      const partyChannels = JSON.parse(cachedValue || '[]');
      if (!partyChannels.includes(channelId)) {
        partyChannels.push(channelId);
        await this.setToCache(cacheKey, JSON.stringify(partyChannels));
      }
    }
  }

  async isPartyChannel(guildId: string, channelId: string) {
    const cacheKey = `partyChannel:${guildId}`;
    const cachedValue = await this.getFromCache(cacheKey);

    return cachedValue?.includes(channelId);
  }

  async deletePartyChannel(guildId: string, channelId: string) {
    const cacheKey = `partyChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      return;
    }

    const partyChannels = JSON.parse(cachedValue || '[]');
    const newPartyChannels = partyChannels.filter((id: string) => id !== channelId);

    await this.setToCache(cacheKey, JSON.stringify(newPartyChannels));
  }

  async saveCommandChannel(guildId: string, channelId: string) {
    const cacheKey = `commandChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      const newCacheValue = [channelId];
      await this.setToCache(cacheKey, JSON.stringify(newCacheValue));
    } else {
      const commandChannels = JSON.parse(cachedValue || '[]');
      if (!commandChannels.includes(channelId)) {
        commandChannels.push(channelId);
        await this.setToCache(cacheKey, JSON.stringify(commandChannels));
      }
    }
  }

  async getServerPartyAreas(guildId: string) {
    const cacheKey = `splitChannel:${guildId}`;

    const splitChannels = JSON.parse((await this.getFromCache(cacheKey)) || '[]');

    const partyAreas = [];

    for (const splitChannel of splitChannels) {
      const partyArea = await this.getPartyArea(guildId, splitChannel);
      partyAreas.push(partyArea);
    }

    return partyAreas;
  }

  async isCommandChannel(guildId: string, channelId: string) {
    const cacheKey = `commandChannel:${guildId}`;
    const cachedValue = await this.getFromCache(cacheKey);

    return cachedValue?.includes(channelId);
  }

  async isCustomVoiceChannel(guildId: string, channelId: string) {
    const cacheKey = `customVoiceChannels:${guildId}`;
    const cachedValue = await this.getFromCache(cacheKey);

    return cachedValue?.includes(channelId);
  }

  async deleteCommandChannel(guildId: string, channelId: string) {
    const cacheKey = `commandChannel:${guildId}`;

    const cachedValue = await this.getFromCache(cacheKey);

    if (cachedValue?.length == 0) {
      return;
    }

    const commandChannels = JSON.parse(cachedValue || '[]');
    const newCommandChannels = commandChannels.filter((id: string) => id !== channelId);

    await this.setToCache(cacheKey, JSON.stringify(newCommandChannels));
  }
}

export const database = new DzajDB();
