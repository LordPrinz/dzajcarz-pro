import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { GuildsState } from "./api.ts";
import { GuildList } from "./GuildList.tsx";

const render = (state: GuildsState) => renderToString(<GuildList state={state} />);

describe("GuildList", () => {
  test("shows that servers are loading", () => {
    expect(render({ kind: "loading" })).toContain("Ładowanie serwerów");
  });

  test("shows 'Bot niedostępny' when the bot is unavailable", () => {
    expect(render({ kind: "unavailable" })).toContain("Bot niedostępny");
  });

  test("shows a different message for an error", () => {
    const html = render({ kind: "error" });
    expect(html).toContain("Nie udało się pobrać serwerów");
    expect(html).not.toContain("Bot niedostępny");
  });

  test("says so when the bot is in no server", () => {
    expect(render({ kind: "ready", guilds: [] })).toContain("Bot nie jest na żadnym serwerze");
  });

  test("lists the servers with their names, member counts and icons", () => {
    const html = render({
      kind: "ready",
      guilds: [
        {
          id: "100000000000000001",
          name: "Alfa",
          iconUrl: "https://cdn.example/a.png",
          memberCount: 3,
        },
        { id: "200000000000000002", name: "Żaba", iconUrl: null, memberCount: 12 },
      ],
    });
    expect(html).toContain("Alfa");
    expect(html).toContain("Żaba");
    expect(html).toContain("Członkowie: <!-- -->3");
    expect(html).toContain("https://cdn.example/a.png");
    // A server without an icon gets its first letter.
    expect(html).toContain(">Ż<");
  });

  test("escapes a server name that holds markup", () => {
    const html = render({
      kind: "ready",
      guilds: [
        {
          id: "100000000000000001",
          name: "<script>alert(1)</script>",
          iconUrl: null,
          memberCount: 1,
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
