import { describe, expect, test } from "bun:test";
import { COMMANDS, MAX_DM_CHANNELS } from "./commands.ts";
import { MAX_MESSAGE_BYTES, ReplyEnvelope } from "./envelope.ts";
import { EVENTS, MAX_DELETED_IDS } from "./events.ts";
import {
  fitMessage,
  fitPage,
  jsonBytes,
  MAX_ATTACHMENTS,
  MAX_CONTENT_LENGTH,
  MAX_EMBED_FIELDS,
  MAX_EMBEDS,
  MAX_NAME_LENGTH,
  MAX_PAGE_MESSAGES,
  MAX_RESOLVED,
  MAX_RESOLVED_NAME_LENGTH,
  MESSAGE_BUDGET_BYTES,
  mentionIds,
  PAGE_BUDGET_BYTES,
  PanelMessage,
  type PanelMessageSource,
  type Resolved,
  toEmbedCard,
  toPanelMessage,
} from "./messages.ts";

const id = (n: number) => String(100000000000000000n + BigInt(n));
/** JSON escapes a control character as six bytes: the most a single character can take. */
const worst = (length: number) => "\u0001".repeat(length);

function source(overrides: Partial<PanelMessageSource> = {}): PanelMessageSource {
  return {
    id: id(1),
    guildId: id(2),
    channelId: id(3),
    author: {
      id: id(4),
      username: "ola",
      displayName: "Ola",
      avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png",
      bot: false,
    },
    content: "hej",
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    editedAt: null,
    ...overrides,
  };
}

/** A message at every schema maximum, every string made of the costliest character. */
function worstMessage(n: number) {
  const url = `https://cdn.discordapp.com/${"a".repeat(2000)}`;
  const media = { url, width: 1, height: 1 };
  return PanelMessage.parse({
    id: id(n),
    guildId: id(2),
    channelId: id(3),
    author: {
      id: id(4),
      username: worst(MAX_NAME_LENGTH),
      displayName: worst(MAX_NAME_LENGTH),
      avatarUrl: `https://cdn.discordapp.com/${"a".repeat(200)}`,
      bot: false,
    },
    content: worst(MAX_CONTENT_LENGTH),
    attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      id: id(i),
      name: worst(256),
      url,
      contentType: worst(128),
      size: 1,
      width: 1,
      height: 1,
    })),
    embeds: Array.from({ length: MAX_EMBEDS }, () => ({
      title: worst(256),
      description: worst(4096),
      url,
      color: 1,
      authorName: worst(256),
      providerName: worst(256),
      footer: worst(2048),
      image: media,
      thumbnail: media,
      video: media,
      fields: Array.from({ length: MAX_EMBED_FIELDS }, () => ({
        name: worst(256),
        value: worst(1024),
        inline: true,
      })),
    })),
    replyToId: id(5),
    createdAt: "2026-11-01T10:00:00.000Z",
    editedAt: "2026-11-01T10:00:00.000Z",
    deletedAt: null,
    truncated: false,
  });
}

function worstResolved(): Resolved {
  const names = Object.fromEntries(
    Array.from({ length: MAX_RESOLVED }, (_, i) => [id(i), worst(MAX_RESOLVED_NAME_LENGTH)]),
  );
  return {
    users: names,
    channels: names,
    roles: Object.fromEntries(
      Object.keys(names).map((key) => [key, { name: worst(MAX_RESOLVED_NAME_LENGTH), color: 1 }]),
    ),
  };
}

const replyBytes = (result: unknown) =>
  jsonBytes(ReplyEnvelope.parse({ v: 1, id: crypto.randomUUID(), ok: true, result }));

describe("toPanelMessage", () => {
  test("keeps a well-formed message as it is", () => {
    const message = toPanelMessage(source());
    expect(PanelMessage.safeParse(message).success).toBe(true);
    expect(message).toMatchObject({ content: "hej", createdAt: "2026-11-01T10:00:00.000Z" });
  });

  test("drops what is not https, and avatars off Discord's CDN", () => {
    const message = toPanelMessage(
      source({
        author: { ...source().author, avatarUrl: "https://evil.example/a.png" },
        attachments: [
          { id: "1", name: "a.png", url: "javascript:alert(1)", contentType: "image/png", size: 3 },
          { id: "2", name: "b.png", url: "http://cdn.discordapp.com/b.png", size: 3 },
          "not an attachment",
        ],
        embeds: [{ title: "t", url: "javascript:alert(1)", image: { url: "data:image/png,x" } }],
      }),
    );
    expect(message.author.avatarUrl).toBeNull();
    expect(message.attachments.map((a) => a.url)).toEqual([null, null]);
    expect(message.embeds[0]).toMatchObject({ title: "t", url: null, image: null });
    expect(PanelMessage.safeParse(message).success).toBe(true);
  });

  test("cuts every string to its limit", () => {
    const message = toPanelMessage(
      source({
        content: "x".repeat(5000),
        author: { ...source().author, username: "u".repeat(40), displayName: "d".repeat(40) },
      }),
    );
    expect(message.content).toHaveLength(MAX_CONTENT_LENGTH);
    expect(message.author.username).toHaveLength(MAX_NAME_LENGTH);
    expect(PanelMessage.safeParse(message).success).toBe(true);
  });
});

describe("toEmbedCard", () => {
  test("prefers Discord's proxy copy of an image", () => {
    const card = toEmbedCard({
      image: {
        url: "https://example.com/a.png",
        proxy_url: "https://media.discordapp.net/external/a.png",
        width: 10,
        height: 20,
      },
      fields: [{ name: "a", value: "b", inline: true }, "junk"],
      color: 0xff0000,
      author: { name: "autor" },
      footer: { text: "stopka" },
    });
    expect(card).toMatchObject({
      image: { url: "https://media.discordapp.net/external/a.png", width: 10, height: 20 },
      fields: [{ name: "a", value: "b", inline: true }],
      color: 0xff0000,
      authorName: "autor",
      footer: "stopka",
    });
  });

  test("ignores something that is not an embed", () => {
    expect(toEmbedCard("x")).toBeNull();
    expect(toEmbedCard(null)).toBeNull();
  });
});

describe("mentionIds", () => {
  test("splits users, roles and channels, without duplicates", () => {
    expect(
      mentionIds([`<@${id(1)}> <@!${id(1)}> <@&${id(2)}> <#${id(3)}> <@123> @everyone`]),
    ).toEqual({ users: [id(1)], roles: [id(2)], channels: [id(3)] });
  });

  test("stops at the cap", () => {
    const text = Array.from({ length: MAX_RESOLVED + 10 }, (_, i) => `<@${id(i)}>`).join(" ");
    expect(mentionIds([text]).users).toHaveLength(MAX_RESOLVED);
  });
});

describe("fitting into one protocol message", () => {
  test("a small message is left alone", () => {
    const message = toPanelMessage(source());
    expect(fitMessage(message)).toBe(message);
  });

  test("the worst message shrinks to its budget and says so", () => {
    const fitted = fitMessage(worstMessage(1));
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(MESSAGE_BUDGET_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(PanelMessage.safeParse(fitted).success).toBe(true);
  });

  test("a page of worst messages and worst names fits in a reply", () => {
    const messages = Array.from({ length: MAX_PAGE_MESSAGES }, (_, i) => worstMessage(i));
    const page = fitPage(messages, worstResolved());
    expect(jsonBytes({ messages: page.messages, resolved: page.resolved })).toBeLessThanOrEqual(
      PAGE_BUDGET_BYTES,
    );
    expect(page.dropped).toBe(MAX_PAGE_MESSAGES - page.messages.length);
    // The newest are kept.
    expect(page.messages.at(-1)?.id).toBe(id(MAX_PAGE_MESSAGES - 1));
    const result = COMMANDS["channel.messages"].response.parse({
      status: "ok",
      ...page,
      hasMore: true,
    });
    expect(replyBytes(result)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  test("an ordinary page loses nothing", () => {
    const messages = Array.from({ length: MAX_PAGE_MESSAGES }, (_, i) =>
      toPanelMessage(source({ id: id(i), content: "x".repeat(300) })),
    );
    const page = fitPage(messages, { users: { [id(1)]: "Ola" }, roles: {}, channels: {} });
    expect(page.dropped).toBe(0);
    expect(page.resolved.users).toEqual({ [id(1)]: "Ola" });
  });

  test("a message event with the worst message and names fits in an event", () => {
    const page = fitPage([worstMessage(1)], worstResolved());
    const payload = EVENTS["message.created"].parse({
      message: page.messages[0],
      resolved: page.resolved,
    });
    expect(jsonBytes({ v: 1, event: "message.created", payload, at: 1 })).toBeLessThanOrEqual(
      MAX_MESSAGE_BYTES,
    );
  });
});

describe("worst-case replies of the reading commands", () => {
  test("dms.list", () => {
    const result = COMMANDS["dms.list"].response.parse({
      channels: Array.from({ length: MAX_DM_CHANNELS }, (_, i) => ({
        channelId: id(i),
        recipient: {
          id: id(i),
          username: worst(MAX_NAME_LENGTH),
          displayName: worst(MAX_NAME_LENGTH),
          avatarUrl: `https://cdn.discordapp.com/${"a".repeat(200)}`,
        },
        lastMessageId: id(i),
      })),
      truncated: true,
    });
    expect(replyBytes(result)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  test("names.resolve", () => {
    expect(
      replyBytes(COMMANDS["names.resolve"].response.parse(worstResolved())),
    ).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  test("message.deleted", () => {
    const payload = EVENTS["message.deleted"].parse({
      guildId: id(1),
      channelId: id(2),
      ids: Array.from({ length: MAX_DELETED_IDS }, (_, i) => id(i)),
    });
    expect(jsonBytes(payload)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  test("rejects more names than the cap and requests over the page size", () => {
    const users = Object.fromEntries(
      Array.from({ length: MAX_RESOLVED + 1 }, (_, i) => [id(i), "x"]),
    );
    expect(
      COMMANDS["names.resolve"].response.safeParse({ users, roles: {}, channels: {} }).success,
    ).toBe(false);
    expect(
      COMMANDS["channel.messages"].request.safeParse({ channelId: id(1), limit: 51 }).success,
    ).toBe(false);
    expect(
      COMMANDS["channel.messages"].request.safeParse({ channelId: "1", limit: 10 }).success,
    ).toBe(false);
  });
});
