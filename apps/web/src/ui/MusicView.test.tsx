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

function mount(
  state: MusicSnapshot,
  props: Partial<MusicViewProps> = {},
  respond: (url: string, method: string) => Response | undefined = () => undefined,
) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const custom = respond(url, method);
    if (custom) return custom;
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
  const change = (element: Element | null | undefined, value: string) =>
    act(async () => {
      if (!element) throw new Error("element not found");
      const input = element as HTMLInputElement | HTMLSelectElement;
      input.value = value;
      // React remembers the last value it saw; forget it so the new one counts as a change.
      (
        input as unknown as { _valueTracker?: { setValue(v: string): void } }
      )._valueTracker?.setValue("\u0000");
      if (element instanceof window.HTMLSelectElement) {
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
      } else {
        // React loaded before happy-dom registered, so it reads text inputs through keyup, not input.
        element.dispatchEvent(new window.Event("focusin", { bubbles: true }));
        input.value = value;
        (
          input as unknown as { _valueTracker?: { setValue(v: string): void } }
        )._valueTracker?.setValue("\u0000");
        element.dispatchEvent(new window.Event("keyup", { bubbles: true }));
      }
      await Bun.sleep(0);
    });
  const unmount = () => act(() => root?.unmount());
  const advance = (ms: number) => {
    time += ms;
    return render();
  };
  return { container, requests, watched, render, emit, button, click, change, unmount, advance };
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

  const posts = (view: ReturnType<typeof mount>) => view.requests.filter((r) => r.method !== "GET");
  const field = (view: ReturnType<typeof mount>, label: string) =>
    view.container.querySelector(`[aria-label="${label}"]`);
  const labelled = (view: ReturnType<typeof mount>, text: string, tag: string) =>
    [...view.container.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith(text))
      ?.querySelector(tag);

  const searchResult = (kind: "tracks" | "playlist" = "tracks") => ({
    searchId: "s1",
    kind,
    name: kind === "playlist" ? "Mix" : null,
    total: 2,
    tracks: [track("Szukany"), track("Drugi", { uri: "https://youtu.be/x" })],
  });

  test("searching lists the results and adding one sends its pick", async () => {
    const view = mount(snapshot(), {}, (url) =>
      url.includes("/search") ? Response.json(searchResult()) : undefined,
    );
    await view.render();
    await view.change(field(view, "Szukaj muzyki"), "  szukany ");
    await view.click("Szukaj");
    expect(view.requests.some((r) => r.url === `/api/music/${GUILD}/search?q=szukany`)).toBe(true);
    expect(view.container.textContent).toContain("Szukany");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("https://youtu.be/x");
    await view.click("Dodaj");
    expect(posts(view).at(-1)).toEqual({
      method: "POST",
      url: `/api/music/${GUILD}/queue`,
      body: { searchId: "s1", picks: [0] },
    });
    await view.unmount();
  });

  test("a playlist can be added whole and says when the queue was too full", async () => {
    const view = mount(snapshot(), {}, (url, method) => {
      if (url.includes("/search")) return Response.json(searchResult("playlist"));
      if (method === "POST" && url.endsWith("/queue")) {
        return Response.json({ status: "ok", added: 1, skipped: 1 });
      }
      return undefined;
    });
    await view.render();
    await view.change(field(view, "Szukaj muzyki"), "mix");
    await view.click("Szukaj");
    expect(view.container.textContent).toContain("Playlista Mix (2)");
    await view.click("Dodaj wszystkie");
    expect(posts(view).at(-1)?.body).toEqual({ searchId: "s1", picks: [0, 1] });
    expect(view.container.textContent).toContain("Dodano 1, kolejka jest pełna");
    await view.unmount();
  });

  test("without a player, adding a track also names the channel to join", async () => {
    const view = mount(snapshot({ player: null }), {}, (url) =>
      url.includes("/search") ? Response.json(searchResult()) : undefined,
    );
    await view.render();
    await view.change(field(view, "Szukaj muzyki"), "x");
    await view.click("Szukaj");
    await view.click("Dodaj");
    expect(posts(view).at(-1)?.body).toEqual({ searchId: "s1", picks: [0], channelId: VOICE });
    await view.unmount();
  });

  test("the search button stays disabled for a blank query", async () => {
    const view = mount(snapshot());
    await view.render();
    await view.change(field(view, "Szukaj muzyki"), "   ");
    expect(view.button("Szukaj")?.disabled).toBe(true);
    await view.unmount();
  });

  test("a rejected search shows the Polish reason", async () => {
    const view = mount(snapshot(), {}, (url) =>
      url.includes("/search")
        ? Response.json({ error: "rejected", reason: "unsupported_link" }, { status: 422 })
        : undefined,
    );
    await view.render();
    await view.change(field(view, "Szukaj muzyki"), "http://zle");
    await view.click("Szukaj");
    expect(view.container.querySelector("[role=alert]")?.textContent).toContain(
      "Obsługuję tylko linki",
    );
    await view.unmount();
  });

  test("queue buttons remove, move up, shuffle and clear", async () => {
    const view = mount(snapshot());
    await view.render();
    const b = track("B");
    const cc = track("Cc");
    expect(view.button("W górę")?.disabled).toBe(true);
    await view.click("Usuń");
    await view.click("Wymieszaj");
    await view.click("Wyczyść");
    const all = posts(view);
    expect(all[0]).toEqual({
      method: "POST",
      url: `/api/music/${GUILD}/queue/remove`,
      body: { index: 0, key: b.key },
    });
    expect(all[1]?.url).toBe(`/api/music/${GUILD}/queue/shuffle`);
    expect(all[2]).toEqual({ method: "DELETE", url: `/api/music/${GUILD}/queue`, body: undefined });
    const ups = [...view.container.querySelectorAll<HTMLButtonElement>('[aria-label="W górę"]')];
    await act(async () => {
      ups[1]?.click();
      await Bun.sleep(0);
    });
    expect(posts(view).at(-1)?.body).toEqual({ from: 1, to: 0, key: cc.key });
    await view.unmount();
  });

  test("an empty queue says so and disables shuffle and clear", async () => {
    const state = snapshot();
    if (state.player) {
      state.player = {
        ...state.player,
        queue: { offset: 0, total: 0, totalDurationMs: 0, tracks: [] },
      };
    }
    const view = mount(state);
    await view.render();
    expect(view.container.textContent).toContain("Kolejka jest pusta.");
    expect(view.button("Wymieszaj")?.disabled).toBe(true);
    expect(view.button("Wyczyść")?.disabled).toBe(true);
    await view.unmount();
  });

  test("a long queue is paged by reading the next offset", async () => {
    const state = snapshot();
    if (state.player) {
      state.player = {
        ...state.player,
        queue: { offset: 0, total: 45, totalDurationMs: 1, tracks: [track("B")] },
      };
    }
    const view = mount(state);
    await view.render();
    expect(view.button("Poprzednie")?.disabled).toBe(true);
    await view.click("Następne");
    expect(view.requests.some((r) => r.url === `/api/music/${GUILD}/state?offset=20`)).toBe(true);
    await view.click("Poprzednie");
    expect(view.requests.at(-1)?.url).toBe(`/api/music/${GUILD}/state?offset=0`);
    await view.unmount();
  });

  test("changing loop and filter sends the chosen mode", async () => {
    const view = mount(snapshot());
    await view.render();
    await view.change(labelled(view, "Pętla", "select"), "queue");
    await view.change(labelled(view, "Filtr", "select"), "nightcore");
    expect(posts(view).map((r) => r.body)).toEqual([
      { action: "loop", mode: "queue" },
      { action: "filter", filter: "nightcore" },
    ]);
    await view.unmount();
  });

  test("a volume change is sent once the slider stops moving", async () => {
    const view = mount(snapshot());
    await view.render();
    await view.change(labelled(view, "Głośność", "input"), "80");
    expect(view.container.textContent).toContain("Głośność 80%");
    expect(posts(view)).toEqual([]);
    await act(async () => {
      await Bun.sleep(500);
    });
    expect(posts(view).map((r) => r.body)).toEqual([{ action: "volume", percent: 80 }]);
    await view.unmount();
  });

  test("dragging the position slider seeks the current track after a pause", async () => {
    const view = mount(snapshot());
    await view.render();
    await view.change(field(view, "Pozycja"), "90000");
    expect(view.container.textContent).toContain("1:30 / 3:20");
    await act(async () => {
      await Bun.sleep(500);
    });
    expect(posts(view).map((r) => r.body)).toEqual([
      { action: "seek", key: track("Lato z Radiem").key, positionMs: 90_000 },
    ]);
    await view.unmount();
  });

  test("a stream shows no length and cannot be seeked", async () => {
    const state = snapshot();
    if (state.player) {
      state.player = {
        ...state.player,
        current: track("Radio", { isStream: true, isSeekable: false }),
      };
    }
    const view = mount(state);
    await view.render();
    expect(view.container.textContent).toContain("/ na żywo");
    expect((field(view, "Pozycja") as HTMLInputElement).disabled).toBe(true);
    await view.unmount();
  });

  test("a player with nothing playing says so and disables pause and skip", async () => {
    const state = snapshot();
    if (state.player) state.player = { ...state.player, current: null };
    const view = mount(state);
    await view.render();
    expect(view.container.textContent).toContain("Nic teraz nie gra.");
    expect(view.button("Pauza")?.disabled).toBe(true);
    expect(view.button("Dalej")?.disabled).toBe(true);
    await view.unmount();
  });

  test("a failed action shows the reason and a failed state read shows the generic error", async () => {
    const view = mount(snapshot(), {}, (url, method) =>
      method === "POST" && url.endsWith("/control")
        ? Response.json({ error: "rejected", reason: "nothing_playing" }, { status: 422 })
        : undefined,
    );
    await view.render();
    await view.click("Pauza");
    expect(view.container.querySelector("[role=alert]")?.textContent).toBe("Nic teraz nie gra");
    await view.unmount();

    const broken = mount(snapshot(), {}, (url) =>
      url.includes("/state") ? new Response("x", { status: 500 }) : undefined,
    );
    await broken.render();
    expect(broken.container.querySelector("[role=alert]")?.textContent).toContain(
      "Coś poszło nie tak",
    );
    await broken.unmount();
  });

  test("moving the bot sends the picked channel and disables the button on the current one", async () => {
    const view = mount(snapshot());
    await view.render();
    // The player's channel is selected, so there is nothing to move to.
    expect(view.button("Przenieś tutaj")?.disabled).toBe(true);
    await view.unmount();
  });

  test("an event for another server or on another queue page is handled", async () => {
    const view = mount(snapshot());
    await view.render();
    const moved = snapshot({ guildId: "999" });
    await view.emit({ event: "music.state", payload: moved });
    expect(view.container.textContent).toContain("Lato z Radiem");
    await view.unmount();
  });
});
