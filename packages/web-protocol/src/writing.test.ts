import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands.ts";
import { MAX_MESSAGE_BYTES } from "./envelope.ts";
import { jsonBytes, MAX_NAME_LENGTH } from "./messages.ts";
import {
  Emoji,
  MAX_FILES,
  MAX_MEMBER_RESULTS,
  MAX_MESSAGE_LENGTH,
  MAX_UPLOAD_BYTES,
  Nonce,
} from "./writing.ts";

const CHANNEL = "200000000000000002";
const MESSAGE = "500000000000000001";
const send = {
  channelId: CHANNEL,
  content: "hej",
  allowMentions: false,
  nonce: "abc123",
};

describe("message.send", () => {
  const schema = COMMANDS["message.send"].request;

  test("accepts text, a reply, files and a nonce", () => {
    expect(schema.safeParse(send).success).toBe(true);
    expect(
      schema.safeParse({
        ...send,
        content: "x".repeat(MAX_MESSAGE_LENGTH),
        replyTo: MESSAGE,
        attachmentIds: Array.from({ length: MAX_FILES }, () => crypto.randomUUID()),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...send, content: "", attachmentIds: [crypto.randomUUID()] }).success,
    ).toBe(true);
  });

  test.each([
    ["no mention switch (ADR 10: no default)", { ...send, allowMentions: undefined }],
    ["a mention switch that is not a boolean", { ...send, allowMentions: "true" }],
    ["text over 2000 characters", { ...send, content: "x".repeat(MAX_MESSAGE_LENGTH + 1) }],
    ["no text and no files", { ...send, content: "  " }],
    [
      "more than ten files",
      {
        ...send,
        attachmentIds: Array.from({ length: MAX_FILES + 1 }, () => crypto.randomUUID()),
      },
    ],
    ["a file id that is not a uuid", { ...send, attachmentIds: ["../etc/passwd"] }],
    ["no nonce", { ...send, nonce: undefined }],
    ["an unknown key", { ...send, everyone: true }],
  ])("rejects %s", (_label, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test("the longest request fits in one protocol message", () => {
    const request = schema.parse({
      ...send,
      // Characters JSON escapes into six bytes each: the worst case for the envelope.
      content: "\u0001".repeat(MAX_MESSAGE_LENGTH),
      replyTo: MESSAGE,
      attachmentIds: Array.from({ length: MAX_FILES }, () => crypto.randomUUID()),
    });
    expect(jsonBytes(request) + 512).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("message.edit", () => {
  const schema = COMMANDS["message.edit"].request;
  const edit = { channelId: CHANNEL, messageId: MESSAGE, content: "nowe", allowMentions: true };

  test("needs text and the mention switch", () => {
    expect(schema.safeParse(edit).success).toBe(true);
    expect(schema.safeParse({ ...edit, content: "" }).success).toBe(false);
    expect(schema.safeParse({ ...edit, allowMentions: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...edit, content: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("Emoji", () => {
  test.each([
    "👍",
    "❤️",
    "😂",
    "👍🏽",
    "👨‍👩‍👧",
    "🇵🇱",
    "1️⃣",
    "#️⃣",
    "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    "dzajco:123456789012345678",
    "a:taniec:123456789012345678",
  ])("accepts %s", (value) => {
    expect(Emoji.safeParse(value).success).toBe(true);
  });

  test.each([
    "",
    "a",
    "hej",
    "👍 ",
    "👍x",
    "<:dzajco:123456789012345678>",
    ":123456789012345678",
    "dzajco:12",
    "x:123456789012345678",
    "../../users/@me",
    "%F0%9F%91%8D",
    "👍👍",
    "👍".repeat(40),
  ])("rejects %j", (value) => {
    expect(Emoji.safeParse(value).success).toBe(false);
  });

  test("reaction commands take only a well-formed emoji", () => {
    const target = { channelId: CHANNEL, messageId: MESSAGE };
    expect(COMMANDS["reaction.add"].request.safeParse({ ...target, emoji: "👍" }).success).toBe(
      true,
    );
    expect(COMMANDS["reaction.remove"].request.safeParse({ ...target, emoji: "hej" }).success).toBe(
      false,
    );
  });
});

describe("Nonce", () => {
  test("is at most 25 letters and digits", () => {
    expect(Nonce.safeParse("a".repeat(25)).success).toBe(true);
    expect(Nonce.safeParse("a".repeat(26)).success).toBe(false);
    expect(Nonce.safeParse("a-b").success).toBe(false);
    expect(Nonce.safeParse("").success).toBe(false);
  });
});

describe("members.search and dm.open", () => {
  const member = (i: number) => ({
    id: String(300000000000000000n + BigInt(i)),
    username: "ż".repeat(MAX_NAME_LENGTH),
    displayName: "ż".repeat(MAX_NAME_LENGTH),
    avatarUrl: `https://cdn.discordapp.com/avatars/300000000000000000/${"a".repeat(180)}.png`,
  });

  test("a full result list fits in one protocol message", () => {
    const result = COMMANDS["members.search"].response.parse({
      members: Array.from({ length: MAX_MEMBER_RESULTS }, (_, i) => member(i)),
    });
    expect(jsonBytes(result)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  test("rejects more results than the cap, and a query too short or too long", () => {
    expect(
      COMMANDS["members.search"].response.safeParse({
        members: Array.from({ length: MAX_MEMBER_RESULTS + 1 }, (_, i) => member(i)),
      }).success,
    ).toBe(false);
    const search = COMMANDS["members.search"].request;
    expect(search.safeParse({ guildId: null, query: "ola" }).success).toBe(true);
    expect(search.safeParse({ guildId: null, query: "   " }).success).toBe(false);
    expect(search.safeParse({ guildId: null, query: "o" }).success).toBe(false);
    expect(search.safeParse({ guildId: null, query: "x".repeat(33) }).success).toBe(false);
  });

  test("dm.open answers a channel or a reason", () => {
    const response = COMMANDS["dm.open"].response;
    expect(
      response.safeParse({ status: "ok", channelId: CHANNEL, recipient: member(1) }).success,
    ).toBe(true);
    expect(response.safeParse({ status: "rejected", reason: "unknown_user" }).success).toBe(true);
    expect(response.safeParse({ status: "rejected", reason: "nope" }).success).toBe(false);
  });
});

describe("channel.info", () => {
  test("an upload limit above the panel's ceiling is refused", () => {
    const info = {
      status: "ok",
      guildId: null,
      botUserId: "300000000000000009",
      uploadLimit: MAX_UPLOAD_BYTES,
      can: { send: true, attach: true, history: true, react: true, manage: false },
    };
    expect(COMMANDS["channel.info"].response.safeParse(info).success).toBe(true);
    expect(
      COMMANDS["channel.info"].response.safeParse({ ...info, uploadLimit: MAX_UPLOAD_BYTES + 1 })
        .success,
    ).toBe(false);
  });
});
