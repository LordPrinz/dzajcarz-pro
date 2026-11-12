import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChannelView, type ChannelViewProps } from "./ChannelView.tsx";
import type { MessagePage, PanelMessage } from "./reading-api.ts";
import type { LiveEvent } from "./timeline.ts";

const CHANNEL = "200000000000000002";
const GUILD = "100000000000000001";
const id = (n: number) => String(500000000000000000n + BigInt(n));

function message(n: number): PanelMessage {
  return {
    id: id(n),
    guildId: GUILD,
    channelId: CHANNEL,
    author: {
      id: "300000000000000003",
      username: "ola",
      displayName: null,
      avatarUrl: null,
      bot: false,
    },
    content: `tresc-${n}`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 10, n)).toISOString(),
    editedAt: null,
    deletedAt: null,
    truncated: false,
  };
}

const page = (ns: number[], overrides: Partial<MessagePage> = {}): MessagePage => ({
  source: "archive",
  messages: ns.map(message),
  resolved: { users: {}, roles: {}, channels: {} },
  hasOlder: false,
  hasNewer: false,
  ...overrides,
});

/** A fetch whose answers the test hands out one by one, recording each URL. */
function scriptedFetch() {
  const requests: { url: URL; answer: (body: MessagePage) => void }[] = [];
  const fetcher = (input: string) =>
    new Promise<Response>((resolve) => {
      // What the bot may do here: not part of these tests, so it is unknown.
      if (input.endsWith("/info")) {
        resolve(Response.json({ error: "bot_unavailable" }, { status: 503 }));
        return;
      }
      requests.push({
        url: new URL(input, "http://panel"),
        answer: (body) => resolve(new Response(JSON.stringify(body))),
      });
    });
  return { requests, fetcher };
}

let originalFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function mount() {
  const { requests, fetcher } = scriptedFetch();
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const listeners = new Set<(event: LiveEvent) => void>();
  const subscribe = (listener: (event: LiveEvent) => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const channel = { id: CHANNEL, guildId: GUILD, name: "ogólny" };
  const render = (props: Partial<ChannelViewProps> = {}) =>
    act(() => {
      root ??= createRoot(container);
      root.render(<ChannelView channel={channel} subscribe={subscribe} {...props} />);
    });
  const emit = (event: LiveEvent) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  const answer = (index: number, body: MessagePage) =>
    act(async () => {
      requests[index]?.answer(body);
      await Bun.sleep(0);
    });
  const shown = () => [...container.textContent.matchAll(/tresc-(\d+)/g)].map((m) => Number(m[1]));
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  const unmount = () => act(() => root?.unmount());
  return { requests, render, emit, answer, shown, button, unmount };
}

const created = (n: number): LiveEvent => ({
  event: "message.created",
  payload: { message: message(n), resolved: { users: {}, roles: {}, channels: {} } },
});

describe("ChannelView", () => {
  test("a message that arrives before the first page is not lost", async () => {
    const view = mount();
    await view.render();
    await view.emit(created(3));
    await view.answer(0, page([1, 2]));
    expect(view.shown()).toEqual([1, 2, 3]);
    await view.unmount();
  });

  test("older pages load once at a time, from the source the view came from", async () => {
    const view = mount();
    await view.render();
    await view.answer(0, page([5, 6], { source: "live", hasOlder: true }));
    const older = view.button("Starsze");
    await act(() => {
      older?.click();
      older?.click();
    });
    expect(view.requests).toHaveLength(2);
    expect(view.requests[1]?.url.searchParams.get("before")).toBe(id(5));
    expect(view.requests[1]?.url.searchParams.get("source")).toBe("live");
    await view.answer(1, page([3, 4], { source: "live" }));
    expect(view.shown()).toEqual([3, 4, 5, 6]);
    await view.unmount();
  });

  test("after a reconnect the view at the latest end fetches what it missed", async () => {
    const view = mount();
    await view.render();
    await view.answer(0, page([1, 2]));
    await view.render({ reconnects: 1 });
    expect(view.requests).toHaveLength(2);
    expect(view.requests[1]?.url.searchParams.has("before")).toBe(false);
    expect(view.requests[1]?.url.searchParams.get("source")).toBe("archive");
    await view.answer(1, page([2, 3, 4]));
    expect(view.shown()).toEqual([1, 2, 3, 4]);
    await view.unmount();
  });

  test("a view opened around a message only says to refresh after a reconnect", async () => {
    const view = mount();
    await view.render({ focusId: id(2) });
    expect(view.requests[0]?.url.searchParams.get("around")).toBe(id(2));
    await view.answer(0, page([1, 2, 3], { hasNewer: true }));
    await view.render({ focusId: id(2), reconnects: 1 });
    expect(view.requests).toHaveLength(1);
    expect(document.body.textContent).toContain("Połączenie wznowione");
    await view.unmount();
  });
});
