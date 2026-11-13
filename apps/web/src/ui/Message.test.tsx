import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attachmentKind, Message, type MessageProps, mediaUrl } from "./Message.tsx";
import type { EmbedCard, PanelAttachment, PanelMessage } from "./reading-api.ts";

function message(overrides: Partial<PanelMessage> = {}): PanelMessage {
  return {
    id: "500000000000000001",
    guildId: "100000000000000001",
    channelId: "200000000000000002",
    author: {
      id: "300000000000000003",
      username: "ola",
      displayName: "Ola",
      avatarUrl: "https://cdn.discordapp.com/avatars/3/a.png",
      bot: false,
    },
    content: "hej",
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    truncated: false,
    ...overrides,
  };
}

const render = (overrides: Partial<PanelMessage> = {}, props: Partial<MessageProps> = {}) =>
  renderToStaticMarkup(
    <Message
      message={message(overrides)}
      resolved={{ users: {}, roles: {}, channels: {} }}
      archived
      {...props}
    />,
  );

const attachment = (overrides: Partial<PanelAttachment>): PanelAttachment => ({
  id: "1",
  name: "kot.png",
  url: "https://cdn.discordapp.com/attachments/1/2/kot.png",
  contentType: "image/png",
  size: 2048,
  width: 100,
  height: 50,
  ...overrides,
});

const embed = (overrides: Partial<EmbedCard>): EmbedCard => ({
  title: null,
  description: null,
  url: null,
  color: null,
  authorName: null,
  providerName: null,
  footer: null,
  image: null,
  thumbnail: null,
  video: null,
  fields: [],
  ...overrides,
});

describe("mediaUrl", () => {
  test("only https on Discord's media hosts", () => {
    expect(mediaUrl("https://cdn.discordapp.com/a.png")).toBe("https://cdn.discordapp.com/a.png");
    expect(mediaUrl("https://media.discordapp.net/a.png")).toBe(
      "https://media.discordapp.net/a.png",
    );
    expect(mediaUrl("http://cdn.discordapp.com/a.png")).toBeNull();
    expect(mediaUrl("https://cdn.discordapp.com.evil.example/a.png")).toBeNull();
    expect(mediaUrl("https://i.imgur.com/a.png")).toBeNull();
    expect(mediaUrl(null)).toBeNull();
  });
});

describe("Message", () => {
  test("author, time, text and avatar", () => {
    const html = render();
    expect(html).toContain("Ola");
    expect(html).toContain('src="https://cdn.discordapp.com/avatars/3/a.png"');
    expect(html).toContain('dateTime="2026-11-01T10:00:00.000Z"');
    expect(html).toContain("hej");
  });

  test("an avatar off Discord's CDN is not loaded", () => {
    const html = render({
      author: { ...message().author, avatarUrl: "https://evil.example/a.png" },
    });
    expect(html).not.toContain("evil.example");
    expect(html).toContain("avatar-fallback");
  });

  test("images and video inline, other files as links", () => {
    const html = render({
      attachments: [
        attachment({}),
        attachment({ id: "2", name: "film.mp4", contentType: "video/mp4" }),
        attachment({
          id: "3",
          name: "plik.zip",
          contentType: "application/zip",
          size: 3 * 1024 * 1024,
        }),
        attachment({ id: "4", name: "gdzie.png", url: "https://example.com/gdzie.png" }),
        attachment({ id: "5", name: "zly.png", url: null }),
      ],
    });
    expect(html).toContain(
      '<img src="https://cdn.discordapp.com/attachments/1/2/kot.png" alt="kot.png"',
    );
    expect(html).toContain('<video class="attachment-media"');
    expect(html).toContain(">plik.zip</a>");
    expect(html).toContain("3 MB");
    // Another host: a link, not an image.
    expect(html).not.toContain('<img src="https://example.com');
    expect(html).toContain('href="https://example.com/gdzie.png"');
    expect(html).toContain("zly.png (brak linku)");
  });

  test("embeds are cards; images off Discord's hosts are links, javascript: never a link", () => {
    const html = render({
      embeds: [
        embed({
          title: "Tytuł",
          url: "javascript:alert(1)",
          description: "**opis**",
          color: 0x00ff00,
          fields: [{ name: "Pole", value: "wartość", inline: true }],
          image: { url: "https://media.discordapp.net/external/a.png", width: 1, height: 1 },
          thumbnail: { url: "https://example.com/t.png", width: 1, height: 1 },
          footer: "stopka",
        }),
      ],
    });
    expect(html).toContain('class="embed"');
    expect(html).toContain("border-left-color:#00ff00");
    expect(html).toContain("Tytuł");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<strong>opis</strong>");
    expect(html).toContain("<dt>Pole</dt>");
    expect(html).toContain('src="https://media.discordapp.net/external/a.png"');
    expect(html).not.toContain('src="https://example.com/t.png"');
    expect(html).toContain('href="https://example.com/t.png"');
    expect(html).toContain("stopka");
  });

  test("edited messages in the archive offer their history; live ones only say edited", () => {
    const edited = { editedAt: "2026-11-01T11:00:00.000Z" };
    expect(render(edited)).toMatch(/<button[^>]*>\(edytowano\)<\/button>/);
    expect(render(edited, { archived: false })).toContain('<span class="muted">(edytowano)</span>');
  });

  test("a deleted message stays and is marked", () => {
    const html = render({ deletedAt: "2026-11-01T12:00:00.000Z" });
    expect(html).toContain("message-deleted");
    expect(html).toContain("usunięta");
    expect(html).toContain("hej");
  });

  test("a message that holds HTML and a script renders it as text", () => {
    const html = render({ content: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

test("attachmentKind falls back on the file name", () => {
  expect(attachmentKind(attachment({ contentType: null, name: "a.JPG" }))).toBe("image");
  expect(attachmentKind(attachment({ contentType: null, name: "a.webm" }))).toBe("video");
  expect(attachmentKind(attachment({ contentType: null, name: "a.txt" }))).toBe("file");
});
