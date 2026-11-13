import { MAX_VOICE_CHANNELS, type VoiceChannelInfo } from "@dzajcarz/web-protocol";
import {
  ChannelType,
  type Client,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { VoiceDirectory } from "../web-music.ts";

// A stage is left out: the bot joins it suppressed and would play to nobody (see schedule.ts).
const isVoice = (channel: GuildBasedChannel | undefined): channel is VoiceChannel =>
  channel?.type === ChannelType.GuildVoice;

/**
 * What the bot needs besides Discord's `joinable` (View Channel and Connect, and room in a channel with a
 * user limit unless the bot may move members): Speak, or it would sit there silent, and Send Messages and
 * Embed Links in the channel's chat, where the Discord panel of music started from the web goes.
 */
const NEEDED = [
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

function canJoin(channel: VoiceBasedChannel): boolean {
  const me = channel.guild.members.me;
  return Boolean(me && channel.joinable && channel.permissionsFor(me)?.has(NEEDED));
}

/** The voice channels of a guild from the gateway cache, in Discord's order. */
export function createVoiceDirectory(client: Client): VoiceDirectory {
  return {
    list(guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;
      const position = (channel: GuildBasedChannel | undefined) =>
        channel && "rawPosition" in channel ? channel.rawPosition : -1;
      const voice = [...guild.channels.cache.values()]
        .filter(isVoice)
        .sort(
          (a, b) =>
            position(a.parent ?? undefined) - position(b.parent ?? undefined) ||
            a.rawPosition - b.rawPosition ||
            a.id.localeCompare(b.id),
        );
      const channels: VoiceChannelInfo[] = voice.slice(0, MAX_VOICE_CHANNELS).map((channel) => ({
        id: channel.id,
        name: channel.name.slice(0, 100),
        parentId: channel.parentId,
        listeners: channel.members.filter((member) => !member.user.bot).size,
        joinable: canJoin(channel),
      }));
      return { channels, truncated: voice.length > channels.length };
    },
    check(guildId, channelId) {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
      if (!isVoice(channel)) return "unknown_channel";
      return canJoin(channel) ? "ok" : "no_connect";
    },
  };
}
