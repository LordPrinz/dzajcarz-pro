import type { ClientEvents } from "discord.js";

/** The channel part of a message or interaction that toggles are looked up by. */
interface MaybeThread {
  isThread?(): boolean;
  parentId?: string | null;
}

/**
 * Toggles are set on channels, and a thread has no toggle of its own: it follows its parent channel.
 * `channel` may be null for uncached channels, in which case the plain channel id is used.
 */
export function toggleChannelId(
  channel: MaybeThread | null | undefined,
  channelId: string,
): string {
  return channel?.isThread?.() && channel.parentId ? channel.parentId : channelId;
}

/** The bot's view of a channel registry, enough to find a thread's parent. */
interface ChannelCache {
  get(channelId: string): MaybeThread | undefined;
}

/**
 * The `moduleEnabled` dependency of modules: asks the gate about the channel a caller is in, resolving a
 * thread to its parent channel through the client's channel cache.
 */
export function createModuleEnabled(
  gate: { isEnabled(guildId: string, channelId: string, module: string): Promise<boolean> },
  channels: ChannelCache,
): (guildId: string, channelId: string, module: string) => Promise<boolean> {
  return (guildId, channelId, module) =>
    gate.isEnabled(guildId, toggleChannelId(channels.get(channelId), channelId), module);
}

export interface EventScope {
  guildId: string;
  /** null when the event is about the guild as a whole (a member joined). */
  channelId: string | null;
}

/**
 * Where an event happened, so module toggles can be applied to it. Returns null for events outside a
 * guild and for events no module is gated on: those always reach their handlers.
 */
export function eventScope(event: keyof ClientEvents, args: unknown[]): EventScope | null {
  switch (event) {
    case "messageCreate": {
      const [message] = args as ClientEvents["messageCreate"];
      return scope(message.guildId, toggleChannelId(message.channel, message.channelId));
    }
    case "guildMemberAdd": {
      const [member] = args as ClientEvents["guildMemberAdd"];
      return scope(member.guild.id, null);
    }
    case "voiceStateUpdate": {
      const [oldState, newState] = args as ClientEvents["voiceStateUpdate"];
      return scope(newState.guild.id, newState.channelId ?? oldState.channelId);
    }
    case "channelDelete": {
      const [channel] = args as ClientEvents["channelDelete"];
      return "guildId" in channel ? scope(channel.guildId, channel.id) : null;
    }
    case "interactionCreate": {
      const [interaction] = args as ClientEvents["interactionCreate"];
      return scope(
        interaction.guildId,
        interaction.channelId && toggleChannelId(interaction.channel, interaction.channelId),
      );
    }
    default:
      return null;
  }
}

function scope(guildId: string | null | undefined, channelId: string | null): EventScope | null {
  return guildId ? { guildId, channelId } : null;
}
