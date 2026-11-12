import { z } from "zod";
import { Snowflake } from "./snowflake.ts";

/** Discord caps usernames, global names and nicknames at 32 characters. */
export const MAX_NAME_LENGTH = 32;
/** Discord's longest message (with Nitro). */
export const MAX_CONTENT_LENGTH = 4000;
export const MAX_ATTACHMENTS = 10;
export const MAX_EMBEDS = 10;
export const MAX_EMBED_FIELDS = 25;
export const MAX_URL_LENGTH = 2048;
/** At most this many ids of each kind are resolved to names for one page or event. */
export const MAX_RESOLVED = 50;
/** Names in a `Resolved` map are cut to this length. */
export const MAX_RESOLVED_NAME_LENGTH = 50;
/** At most this many messages in one page. */
export const MAX_PAGE_MESSAGES = 50;
/** A reply or event payload made of messages stays under this, leaving room for the envelope in 64 KB. */
export const PAGE_BUDGET_BYTES = 60 * 1024;
/** One message is shrunk until it fits in this. */
export const MESSAGE_BUDGET_BYTES = 16 * 1024;

const HttpsUrl = z.url({ protocol: /^https$/ }).max(MAX_URL_LENGTH);
/** Avatars render as an <img>, so only Discord's CDN, which the CSP allows. */
const AvatarUrl = z
  .url({ protocol: /^https$/, hostname: /^cdn\.discordapp\.com$/ })
  .max(256)
  .nullable();
const Iso = z.iso.datetime({ offset: true });

export const PanelAuthor = z.object({
  id: Snowflake,
  username: z.string().max(MAX_NAME_LENGTH),
  displayName: z.string().max(MAX_NAME_LENGTH).nullable(),
  avatarUrl: AvatarUrl,
  bot: z.boolean(),
});
export type PanelAuthor = z.infer<typeof PanelAuthor>;

export const PanelAttachment = z.object({
  id: z.string().max(32),
  name: z.string().max(256),
  /** null: the stored link was not https. */
  url: HttpsUrl.nullable(),
  contentType: z.string().max(128).nullable(),
  size: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
});
export type PanelAttachment = z.infer<typeof PanelAttachment>;

const EmbedMedia = z.object({
  url: HttpsUrl,
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
});

/** The parts of a Discord embed the panel shows as a card. */
export const EmbedCard = z.object({
  title: z.string().max(256).nullable(),
  description: z.string().max(4096).nullable(),
  url: HttpsUrl.nullable(),
  color: z.number().int().min(0).max(0xffffff).nullable(),
  authorName: z.string().max(256).nullable(),
  providerName: z.string().max(256).nullable(),
  footer: z.string().max(2048).nullable(),
  image: EmbedMedia.nullable(),
  thumbnail: EmbedMedia.nullable(),
  video: EmbedMedia.nullable(),
  fields: z
    .array(
      z.object({
        name: z.string().max(256),
        value: z.string().max(1024),
        inline: z.boolean(),
      }),
    )
    .max(MAX_EMBED_FIELDS),
});
export type EmbedCard = z.infer<typeof EmbedCard>;

/** One message as the panel shows it, from the archive or live from Discord. */
export const PanelMessage = z.object({
  id: Snowflake,
  /** null: a DM. */
  guildId: Snowflake.nullable(),
  channelId: Snowflake,
  author: PanelAuthor,
  content: z.string().max(MAX_CONTENT_LENGTH),
  attachments: z.array(PanelAttachment).max(MAX_ATTACHMENTS),
  embeds: z.array(EmbedCard).max(MAX_EMBEDS),
  replyToId: Snowflake.nullable(),
  createdAt: Iso,
  editedAt: Iso.nullable(),
  /** Only archived messages can be deleted and still shown. */
  deletedAt: Iso.nullable(),
  /** Parts were left out so the message fits in one protocol message. */
  truncated: z.boolean(),
});
export type PanelMessage = z.infer<typeof PanelMessage>;

const atMost =
  (max: number) =>
  (value: Record<string, unknown>): boolean =>
    Object.keys(value).length <= max;

/** Names for the ids mentioned in some messages; an id missing here renders as unknown. */
export const Resolved = z.object({
  users: z.record(Snowflake, z.string().max(MAX_RESOLVED_NAME_LENGTH)).refine(atMost(MAX_RESOLVED)),
  roles: z
    .record(
      Snowflake,
      z.object({
        name: z.string().max(MAX_RESOLVED_NAME_LENGTH),
        color: z.number().int().min(0).max(0xffffff).nullable(),
      }),
    )
    .refine(atMost(MAX_RESOLVED)),
  channels: z
    .record(Snowflake, z.string().max(MAX_RESOLVED_NAME_LENGTH))
    .refine(atMost(MAX_RESOLVED)),
});
export type Resolved = z.infer<typeof Resolved>;

export const emptyResolved = (): Resolved => ({ users: {}, roles: {}, channels: {} });

/** A message as both the archive and discord.js can describe it; `toPanelMessage` checks every part. */
export interface PanelMessageSource {
  id: string;
  guildId: string | null;
  channelId: string;
  author: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    bot: boolean;
  };
  content: string;
  /** Stored JSON: anything, kept only where it has the expected shape. */
  attachments: readonly unknown[];
  /** Discord's embed JSON. */
  embeds: readonly unknown[];
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt?: Date | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : null;

const size = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const httpsUrl = (value: unknown): string | null =>
  typeof value === "string" && HttpsUrl.safeParse(value).success ? value : null;

/** `value` when it is an avatar link the panel may show (Discord's CDN, https, short), else null. */
export const discordAvatarUrl = (value: unknown): string | null =>
  AvatarUrl.safeParse(value).success ? (value as string) : null;

/** Discord's proxy copy first: it lives on a Discord host the panel may load. */
function media(value: unknown): z.infer<typeof EmbedMedia> | null {
  if (!isRecord(value)) return null;
  const url = httpsUrl(value.proxy_url) ?? httpsUrl(value.url);
  return url ? { url, width: size(value.width), height: size(value.height) } : null;
}

/** A Discord embed (API JSON) as a card; unknown or malformed parts are left out. */
export function toEmbedCard(raw: unknown): EmbedCard | null {
  if (!isRecord(raw)) return null;
  const color = size(raw.color);
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  return {
    title: text(raw.title, 256),
    description: text(raw.description, 4096),
    url: httpsUrl(raw.url),
    color: color !== null && color <= 0xffffff ? color : null,
    authorName: isRecord(raw.author) ? text(raw.author.name, 256) : null,
    providerName: isRecord(raw.provider) ? text(raw.provider.name, 256) : null,
    footer: isRecord(raw.footer) ? text(raw.footer.text, 2048) : null,
    image: media(raw.image),
    thumbnail: media(raw.thumbnail),
    video: media(raw.video),
    fields: fields
      .filter(isRecord)
      .slice(0, MAX_EMBED_FIELDS)
      .map((field) => ({
        name: text(field.name, 256) ?? "",
        value: text(field.value, 1024) ?? "",
        inline: field.inline === true,
      })),
  };
}

function toAttachment(raw: unknown): PanelAttachment | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id.slice(0, 32),
    name: text(raw.name, 256) ?? "plik",
    url: httpsUrl(raw.url),
    contentType: text(raw.contentType, 128),
    size: size(raw.size) ?? 0,
    width: size(raw.width),
    height: size(raw.height),
  };
}

const notNull = <T>(value: T | null): value is T => value !== null;

/** Stored attachments in the panel's shape; malformed ones are left out. */
export const panelAttachments = (raw: readonly unknown[]): PanelAttachment[] =>
  raw.map(toAttachment).filter(notNull).slice(0, MAX_ATTACHMENTS);

/** Stored embeds as cards; malformed ones are left out. */
export const panelEmbeds = (raw: readonly unknown[]): EmbedCard[] =>
  raw.map(toEmbedCard).filter(notNull).slice(0, MAX_EMBEDS);

/** A message in the panel's shape: every string cut to its limit, every URL checked. */
export function toPanelMessage(source: PanelMessageSource): PanelMessage {
  return {
    id: source.id,
    guildId: source.guildId,
    channelId: source.channelId,
    author: {
      id: source.author.id,
      username: source.author.username.slice(0, MAX_NAME_LENGTH),
      displayName: source.author.displayName?.slice(0, MAX_NAME_LENGTH) ?? null,
      avatarUrl: discordAvatarUrl(source.author.avatarUrl),
      bot: source.author.bot,
    },
    content: source.content.slice(0, MAX_CONTENT_LENGTH),
    attachments: panelAttachments(source.attachments),
    embeds: panelEmbeds(source.embeds),
    replyToId: source.replyToId,
    createdAt: source.createdAt.toISOString(),
    editedAt: source.editedAt?.toISOString() ?? null,
    deletedAt: source.deletedAt?.toISOString() ?? null,
    truncated: false,
  };
}

export interface MentionIds {
  users: string[];
  roles: string[];
  channels: string[];
}

const MENTION = /<(@!?|@&|#)(\d{17,20})>/g;

/** The ids mentioned in some texts, each kind deduplicated and capped at `MAX_RESOLVED`. */
export function mentionIds(texts: readonly string[]): MentionIds {
  const users = new Set<string>();
  const roles = new Set<string>();
  const channels = new Set<string>();
  for (const value of texts) {
    for (const [, sigil, id = ""] of value.matchAll(MENTION)) {
      const target = sigil === "#" ? channels : sigil === "@&" ? roles : users;
      if (target.size < MAX_RESOLVED) target.add(id);
    }
  }
  return { users: [...users], roles: [...roles], channels: [...channels] };
}

/** The texts of a message that can hold mentions: its content and its embeds' descriptions and fields. */
export const mentionTexts = (message: PanelMessage): string[] => [
  message.content,
  ...message.embeds.flatMap((embed) => [
    embed.description ?? "",
    ...embed.fields.map((field) => field.value),
  ]),
];

/** Bytes `value` takes as JSON. */
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * Shrinks a message until it fits in `budget` bytes: first its embeds lose their long text, then they go,
 * then the content is cut, then the attachments go. Each step sets `truncated`.
 */
export function fitMessage(message: PanelMessage, budget = MESSAGE_BUDGET_BYTES): PanelMessage {
  const steps: ((m: PanelMessage) => PanelMessage)[] = [
    (m) => ({
      ...m,
      embeds: m.embeds.map((embed) => ({
        ...embed,
        description: embed.description?.slice(0, 200) ?? null,
        footer: null,
        fields: [],
      })),
    }),
    (m) => ({ ...m, embeds: [] }),
    (m) => ({ ...m, content: m.content.slice(0, 500) }),
    (m) => ({ ...m, attachments: [] }),
  ];
  let current = message;
  for (const step of steps) {
    if (jsonBytes(current) <= budget) return current;
    current = { ...step(current), truncated: true };
  }
  return current;
}

/**
 * A page of messages (oldest first) and its names, cut to fit in `budget` bytes as JSON: every message is
 * shrunk to its own budget, then the oldest are dropped, and as a last resort the names. `dropped` counts the
 * messages left out, so the caller knows there is more before the first one kept.
 */
export function fitPage(
  messages: readonly PanelMessage[],
  resolved: Resolved,
  budget = PAGE_BUDGET_BYTES,
): { messages: PanelMessage[]; resolved: Resolved; dropped: number } {
  const kept = messages.map((message) => fitMessage(message));
  let names = resolved;
  let dropped = 0;
  while (jsonBytes({ messages: kept, resolved: names }) > budget) {
    if (kept.length > 1) {
      kept.shift();
      dropped += 1;
    } else if (Object.values(names).some((group) => Object.keys(group).length > 0)) {
      names = emptyResolved();
    } else {
      break;
    }
  }
  return { messages: kept, resolved: names, dropped };
}
