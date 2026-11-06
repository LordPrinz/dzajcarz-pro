import type { Reply } from "@dzajcarz/core";
import type { APIEmbed, MessageMentionOptions } from "discord.js";

/** Bot output can echo user text; it must never ping @everyone, roles or users by accident. */
export const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: false };

export interface ReplyPayload {
  content?: string;
  embeds: APIEmbed[];
  ephemeral: boolean;
}

export function toReplyPayload(reply: Reply): ReplyPayload {
  if (typeof reply === "string") return { content: reply, embeds: [], ephemeral: false };
  return {
    content: reply.content,
    embeds: (reply.embeds ?? []).map((embed) => ({
      title: embed.title,
      description: embed.description,
      color: embed.color,
      fields: embed.fields,
      footer: embed.footer ? { text: embed.footer } : undefined,
    })),
    ephemeral: reply.ephemeral ?? false,
  };
}
