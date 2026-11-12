import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MusicView, type MusicViewProps } from "./MusicView.tsx";
import type { MusicEvent, MusicSnapshot, MusicTrackInfo } from "./music-api.ts";

const GUILD = "100000000000000001";
const VOICE = "400000000000000004";
const AT = "2026-11-12T10:00:00.000Z";

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const track = (title: string, overrides: Partial<MusicTrackInfo> = {}): MusicTrackInfo => ({
  key: `k${title.length}${title.charCodeAt(0).toString(16)}`,
  title,
  author: "Autor",
  durationMs: 200_000,
  uri: null,
  requesterId: "100000000000000099",
  byBot: false,
  isStream: false,
  isSeekable: true,
  ...overrides,
});

const snapshot = (overrides: Partial<MusicSnapshot> = {}): MusicSnapshot => ({
  guildId: GUILD,
  available: true,
  at: AT,
  player: {
    voiceChannelId: VOICE,
    current: track("Lato z Radiem", { byBot: true }),
    positionMs: 30_000,
    paused: false,
    loop: "off",
    volume: 100,
    filter: "off",
    queue: { offset: 0, total: 2, totalDurationMs: 400_000, tracks: [track("B"), track("Cc")] },
  },
  ...overrides,
});

function mount(state: MusicSnapshot, props: Partial<MusicViewProps> = {}) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/voice-channels")) {
      return Response.json({
        channels: [{ id: VOICE, name: "Gadu", parentId: null, listeners: 3, joinable: true }],
        truncated: false,
      });
    }
    if (url.includes("/state")) return Response.json(state);
    return Response.json({ status: "ok" });
  };
  const listeners = new Set<(event: MusicEvent) => void>();
  const watched: (string | null)[] = [];
  // The browser's clock, an hour off the bot's: the position must not care.
  let time = Date.parse(AT) + 3_600_000;
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const render = () =>
    act(async () => {
      root ??= createRoot(container);
      root.render(
        <MusicView
          guilds={[{ id: GUILD, name: "Serwer", iconUrl: null, memberCount: 3 }]}
          botOnline
          watch={(guildId) => void watched.push(guildId)}
          subscribe={(listener) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          }}
          reconnects={0}
          fetcher={fetcher}
          now={() => time}
          {...props}
        />,
      );
      await Bun.sleep(0);
    });
  const emit = (event: MusicEvent) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    );
  const click = (label: string) =>
    act(async () => {
      button(label)?.click();
      await Bun.sleep(0);
    });
  const unmount = () => act(() => root?.unmount());
  const advance = (ms: number) => {
    time += ms;
    return render();
  };
  return { container, requests, watched, render, emit, button, click, unmount, advance };
}

describe("MusicView", () => {
  test("shows the player, follows the server's topic and moves the position on", async () => {
    const view = mount(snapshot());
    await view.render();
    expect(view.watched).toEqual([GUILD]);
    expect(view.container.textContent).toContain("Lato z Radiem");
    expect(view.container.textContent).toContain("utwór bota");
    expect(view.container.textContent).toContain("0:30 / 3:20");
    await view.advance(5_000);
    expect(view.container.textContent).toContain("0:35 / 3:20");
    expect(view.container.textContent).toContain("Kolejka (2 · 6:40)");
    await view.unmount();
    expect(view.watched.at(-1)).toBeNull();
  });

  test("controls work on the bot's own song and send the track key", async () => {
    const view = mount(snapshot());
    await view.render();
    await view.click("Pauza");
    await view.click("Dalej");
    await view.click("W dół");
    const posts = view.requests.filter((r) => r.method !== "GET");
    expect(posts).toEqual([
      { method: "POST", url: `/api/music/${GUILD}/control`, body: { action: "pause" } },
      {
        method: "POST",
        url: `/api/music/${GUILD}/control`,
        body: { action: "skip", key: track("Lato z Radiem").key },
      },
      {
        method: "POST",
        url: `/api/music/${GUILD}/queue/move`,
        body: { from: 0, to: 1, key: track("B").key },
      },
    ]);
    await view.unmount();
  });

  test("with Lavalink down the panel says so and the controls are disabled", async () => {
    const view = mount(snapshot({ available: false }));
    await view.render();
    expect(view.container.textContent).toContain("Lavalink nie działa");
    for (const label of ["Pauza", "Dalej", "Wymieszaj", "Wyczyść", "Usuń"]) {
      expect(view.button(label)?.disabled).toBe(true);
    }
    // Leaving works without the node, as on the bot.
    expect(view.button("Rozłącz")?.disabled).toBe(false);
    await view.unmount();
  });

  test("a live event replaces the state; the node coming back enables the controls", async () => {
    const view = mount(snapshot({ available: false }));
    await view.render();
    await view.emit({ event: "music.status", payload: { available: true } });
    expect(view.button("Pauza")?.disabled).toBe(false);
    const paused = snapshot();
    if (paused.player) paused.player = { ...paused.player, paused: true };
    await view.emit({ event: "music.state", payload: paused });
    expect(view.button("Wznów")).toBeDefined();
    await view.emit({
      event: "music.state",
      payload: { ...paused, guildId: "100000000000000002" },
    });
    expect(view.button("Wznów")).toBeDefined();
    await view.unmount();
  });

  test("an older snapshot arriving after a newer one is dropped", async () => {
    const view = mount(snapshot());
    await view.render();
    const newer = snapshot({ at: "2026-11-12T10:00:10.000Z" });
    if (newer.player) newer.player = { ...newer.player, paused: true };
    await view.emit({ event: "music.state", payload: newer });
    expect(view.button("Wznów")).toBeDefined();
    await view.emit({
      event: "music.state",
      payload: snapshot({ at: "2026-11-12T09:59:00.000Z" }),
    });
    expect(view.button("Wznów")).toBeDefined();
    expect(view.button("Pauza")).toBeUndefined();
    await view.unmount();
  });

  test("a bot offline disables everything", async () => {
    const view = mount(snapshot(), { botOnline: false });
    await view.render();
    expect(view.container.textContent).toContain("Bot offline");
    expect(view.button("Pauza")?.disabled).toBe(true);
    expect(view.button("Rozłącz")?.disabled).toBe(true);
    await view.unmount();
  });

  test("without a player the bot joins the picked channel", async () => {
    const view = mount(snapshot({ player: null }));
    await view.render();
    expect(view.container.textContent).toContain("Bot nie jest na kanale głosowym");
    await view.click("Dołącz");
    expect(view.requests.filter((r) => r.method === "POST")).toEqual([
      { method: "POST", url: `/api/music/${GUILD}/join`, body: { channelId: VOICE } },
    ]);
    await view.unmount();
  });
});
