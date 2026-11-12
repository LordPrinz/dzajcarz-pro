import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, type SidebarProps } from "./Sidebar.tsx";

const GUILD = "100000000000000001";
const noop = () => {};

function render(overrides: Partial<SidebarProps> = {}) {
  return renderToStaticMarkup(
    <Sidebar
      guilds={{
        kind: "ready",
        guilds: [{ id: GUILD, name: "Alfa", iconUrl: null, memberCount: 3 }],
      }}
      expanded={new Set([GUILD])}
      channels={{
        [GUILD]: {
          kind: "ready",
          channels: [
            { id: "1", name: "ogólny", kind: "text", parentId: null },
            { id: "2", name: "wątek", kind: "thread", parentId: "1" },
            { id: "3", name: "forum", kind: "forum", parentId: null },
          ],
          truncated: false,
        },
      }}
      dms={{
        kind: "ready",
        dms: [
          {
            channelId: "9",
            recipient: { id: "5", username: "ola", displayName: "Ola", avatarUrl: null },
            lastActivity: null,
          },
        ],
        botAvailable: true,
        truncated: false,
      }}
      selection={{ kind: "channel", channel: { id: "1", guildId: GUILD, name: "ogólny" } }}
      onExpand={noop}
      onSelect={noop}
      {...overrides}
    />,
  );
}

describe("Sidebar", () => {
  test("servers with channels and threads, a forum not openable, DMs below", () => {
    const html = render();
    expect(html).toContain("Alfa");
    expect(html).toMatch(/aria-current="page"[^>]*># ogólny/);
    expect(html).toContain('class="side-thread"');
    expect(html).toMatch(/disabled[^>]*># forum/);
    expect(html).toContain("@ Ola");
    expect(html).toContain("Discord nie daje botowi listy rozmów");
  });

  test("says when the bot is away", () => {
    const html = render({
      guilds: { kind: "unavailable" },
      dms: { kind: "ready", dms: [], botAvailable: false, truncated: false },
    });
    expect(html).toContain("Bot niedostępny");
    expect(html).toContain("tylko rozmowy z archiwum");
  });
});
