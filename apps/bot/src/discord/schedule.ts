import type { ScheduleVoice } from "@dzajcarz/module-schedule";
import { ChannelType, type Client, type VoiceChannel } from "discord.js";

/**
 * Voice states come from the gateway cache (GuildVoiceStates intent), so no REST call is made. Only
 * plain voice channels count: the bot cannot speak on a stage without being invited, and it must be
 * allowed to join the channel and to speak in it.
 */
export function createScheduleVoice(client: Client): ScheduleVoice {
  return {
    guildIds: () => [...client.guilds.cache.keys()],
    async crowds(guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return [];
      return guild.channels.cache
        .filter(
          (channel): channel is VoiceChannel =>
            channel.type === ChannelType.GuildVoice && channel.joinable && channel.speakable,
        )
        .map((channel) => ({
          channelId: channel.id,
          humans: channel.members.filter((member) => !member.user.bot).size,
        }));
    },
    afkChannelId: (guildId) => client.guilds.cache.get(guildId)?.afkChannelId ?? null,
    async isVoiceChannelOf(guildId, channelId) {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
      return channel?.type === ChannelType.GuildVoice;
    },
  };
}
