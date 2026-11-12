import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ArchiveGuild, type ArchiveGuildProps, backfillText } from "./ArchiveSettings.tsx";
import type { ChannelsState } from "./api.ts";

const GUILD = "100000000000000001";
const noop = () => {};

function render(overrides: Partial<ArchiveGuildProps> = {}) {
  return renderToString(
    <ArchiveGuild
      guild={{ id: GUILD, name: "Alfa", iconUrl: null, memberCount: 3 }}
      settings={{ guildId: GUILD, enabled: true, excludedChannelIds: ["2"] }}
      saving={false}
      expanded={false}
      channels={undefined}
      backfills={{}}
      onToggle={noop}
      onExpand={noop}
      onChannelToggle={noop}
      onBackfill={noop}
      {...overrides}
    />,
  );
}

const ready: ChannelsState = {
  kind: "ready",
  channels: [
    { id: "1", name: "ogólny", kind: "text", parentId: null },
    { id: "2", name: "memy", kind: "text", parentId: null },
    { id: "3", name: "wątek", kind: "thread", parentId: "1" },
    { id: "4", name: "forum", kind: "forum", parentId: null },
  ],
  truncated: false,
};

describe("ArchiveGuild", () => {
  test("shows the server switch and keeps the channels collapsed", () => {
    const html = render();
    expect(html).toContain("Alfa");
    expect(html).toContain("Archiwizuj");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Wczytaj starsze");
  });

  test("an excluded channel is unticked and cannot be backfilled", () => {
    const html = render({ expanded: true, channels: ready });
    expect(html).toContain('aria-expanded="true"');
    const rows = html.split("<li").slice(2);
    const memy = rows.find((row) => row.includes("memy")) ?? "";
    expect(memy).not.toMatch(/type="checkbox" checked/);
    expect(memy).toMatch(/<button[^>]*disabled/);
    const general = rows.find((row) => row.includes("ogólny")) ?? "";
    expect(general).toMatch(/type="checkbox" checked/);
    expect(general).not.toMatch(/<button[^>]*disabled/);
  });

  test("a forum has no backfill button and a thread is marked as one", () => {
    const html = render({ expanded: true, channels: ready });
    const rows = html.split("<li").slice(2);
    expect(rows.find((row) => row.includes("forum"))).not.toContain("Wczytaj starsze");
    expect(rows.find((row) => row.includes("wątek"))).toContain("thread");
  });

  test("a server that is off greys out its channels", () => {
    const html = render({
      expanded: true,
      channels: ready,
      settings: { guildId: GUILD, enabled: false, excludedChannelIds: [] },
    });
    expect(html.match(/<button[^>]*disabled[^>]*>Wczytaj starsze/g)).toHaveLength(3);
  });

  test("tells loading, an unavailable bot and a truncated list apart", () => {
    expect(render({ expanded: true, channels: { kind: "loading" } })).toContain(
      "Ładowanie kanałów",
    );
    expect(render({ expanded: true, channels: { kind: "unavailable" } })).toContain(
      "Bot niedostępny",
    );
    expect(render({ expanded: true, channels: { ...ready, truncated: true } })).toContain(
      "tylko część kanałów",
    );
  });

  test("shows a channel's backfill result and escapes channel names", () => {
    const html = render({
      expanded: true,
      channels: {
        kind: "ready",
        channels: [{ id: "1", name: "<b>x</b>", kind: "text", parentId: null }],
        truncated: false,
      },
      backfills: {
        "1": {
          kind: "done",
          result: { status: "ok", fetched: 100, stored: 7, oldestId: "1", done: false },
        },
      },
    });
    expect(html).toContain("Zapisano 7 z 100");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("backfillText", () => {
  test("covers every outcome in Polish", () => {
    expect(backfillText({ kind: "running" })).toBe("Wczytywanie…");
    expect(
      backfillText({
        kind: "done",
        result: { status: "ok", fetched: 3, stored: 3, oldestId: null, done: true },
      }),
    ).toContain("To już początek kanału");
    expect(backfillText({ kind: "done", result: { status: "not_archived" } })).toBe(
      "Ten kanał nie jest archiwizowany",
    );
    expect(backfillText({ kind: "done", result: { status: "no_access" } })).toContain(
      "nie może czytać",
    );
    expect(backfillText({ kind: "failed", error: "unavailable" })).toBe("Bot niedostępny");
    expect(backfillText({ kind: "failed", error: "audit_unavailable" })).toContain(
      "dziennika zmian",
    );
  });
});
