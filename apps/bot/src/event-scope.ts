import type { ClientEvents } from "discord.js";

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
      return scope(message.guildId, message.channelId);
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
      return scope(interaction.guildId, interaction.channelId);
    }
    default:
      return null;
  }
}

function scope(guildId: string | null | undefined, channelId: string | null): EventScope | null {
  return guildId ? { guildId, channelId } : null;
}
