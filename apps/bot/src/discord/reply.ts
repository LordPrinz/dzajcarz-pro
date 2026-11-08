import type { Reply } from "@dzajcarz/core";
import type { APIEmbed, MessageMentionOptions } from "discord.js";
import { type ComponentRows, toComponentRows } from "./components.ts";

/** Bot output can echo user text; it must never ping @everyone, roles or users by accident. */
export const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: false };

export interface ReplyPayload {
  content?: string;
  embeds: APIEmbed[];
  files: { attachment: Buffer; name: string }[];
  components: ComponentRows;
  ephemeral: boolean;
}

export function toReplyPayload(reply: Reply): ReplyPayload {
  if (typeof reply === "string")
    return { content: reply, embeds: [], files: [], components: [], ephemeral: false };
  return {
    content: reply.content,
    embeds: (reply.embeds ?? []).map((embed) => ({
      title: embed.title,
      url: embed.url,
      description: embed.description,
      thumbnail: embed.thumbnail ? { url: embed.thumbnail } : undefined,
      color: embed.color,
      fields: embed.fields,
      footer: embed.footer ? { text: embed.footer } : undefined,
      author: embed.author
        ? { name: embed.author.name, icon_url: embed.author.iconUrl }
        : undefined,
      image: embed.image ? { url: embed.image } : undefined,
    })),
    files: (reply.files ?? []).map((file) => ({
      attachment: Buffer.from(file.data),
      name: file.name,
    })),
    components: toComponentRows(reply.components),
    ephemeral: reply.ephemeral ?? false,
  };
}
