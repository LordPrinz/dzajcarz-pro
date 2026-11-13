import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageActions } from "./MessageActions.tsx";
import type { PanelMessage } from "./reading-api.ts";
import type { ChannelInfo } from "./write-api.ts";

const CHANNEL = "200000000000000002";
const BOT = "300000000000000001";
const OLA = "300000000000000002";

const info = (manage: boolean, history = true, react = true, dm = false): ChannelInfo => ({
  guildId: dm ? null : "100000000000000001",
  botUserId: BOT,
  uploadLimit: 1024,
  can: { send: true, attach: true, history, react, manage },
});

const message = (author: string): PanelMessage => ({
  id: "500000000000000001",
  guildId: "100000000000000001",
  channelId: CHANNEL,
  author: { id: author, username: "x", displayName: null, avatarUrl: null, bot: author === BOT },
  content: "treść",
  attachments: [],
  embeds: [],
  replyToId: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  editedAt: null,
  deletedAt: null,
  truncated: false,
});

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

function mount(shown: PanelMessage, channelInfo: ChannelInfo | null) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    return Response.json({ status: "ok" });
  }) as unknown as typeof fetch;
  const notices: (string | null)[] = [];
  const replies: PanelMessage[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const render = () =>
    act(() => {
      root ??= createRoot(container);
      root.render(
        <MessageActions
          message={shown}
          info={channelInfo}
          onReply={(m) => replies.push(m)}
          onNotice={(text) => notices.push(text)}
        />,
      );
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
  return { calls, notices, replies, render, button, click, unmount };
}

const PATH = `/api/channels/${CHANNEL}/messages/500000000000000001`;

describe("MessageActions", () => {
  test("only the bot's own messages can be edited", async () => {
    const own = mount(message(BOT), info(false));
    await own.render();
    expect(own.button("Edytuj")).toBeDefined();
    await own.unmount();
    const theirs = mount(message(OLA), info(true));
    await theirs.render();
    expect(theirs.button("Edytuj")).toBeUndefined();
    await theirs.unmount();
  });

  test("a truncated message cannot be edited: saving would overwrite the full text", async () => {
    const view = mount({ ...message(BOT), truncated: true }, info(false));
    await view.render();
    expect(view.button("Edytuj")).toBeUndefined();
    await view.unmount();
  });

  test("without Manage Messages, deleting someone else's message says why and sends nothing", async () => {
    const view = mount(message(OLA), info(false));
    await view.render();
    await view.click("Usuń");
    expect(view.notices).toEqual([
      "Bot nie ma uprawnienia „Zarządzanie wiadomościami”, więc nie usunie cudzej wiadomości",
    ]);
    expect(view.button("Tak, usuń")).toBeUndefined();
    expect(view.calls).toEqual([]);
    await view.unmount();
  });

  test("in a DM the other side's message cannot be deleted, and the panel says so", async () => {
    const view = mount(message(OLA), info(false, true, true, true));
    await view.render();
    await view.click("Usuń");
    expect(view.notices).toEqual(["W DM bot usuwa tylko swoje wiadomości"]);
    expect(view.calls).toEqual([]);
    await view.unmount();
  });

  test("with Manage Messages someone else's message is deleted after a confirmation", async () => {
    const view = mount(message(OLA), info(true));
    await view.render();
    await view.click("Usuń");
    expect(view.calls).toEqual([]);
    await view.click("Tak, usuń");
    expect(view.calls).toEqual([{ url: PATH, method: "DELETE", body: null }]);
    expect(view.notices).toEqual(["Usunięto wiadomość"]);
    await view.unmount();
  });

  test("the bot's own message can always be deleted", async () => {
    const view = mount(message(BOT), info(false));
    await view.render();
    await view.click("Usuń");
    await view.click("Tak, usuń");
    expect(view.calls.map((call) => call.method)).toEqual(["DELETE"]);
    await view.unmount();
  });

  test("a quick emoji adds the bot's reaction; with the box ticked it removes it", async () => {
    const view = mount(message(OLA), info(false));
    await view.render();
    await view.click("Reaguj");
    await view.click("Dodaj 👍");
    expect(view.calls).toEqual([
      { url: `${PATH}/reactions`, method: "PUT", body: { emoji: "👍" } },
    ]);
    await view.click("Reaguj");
    await act(() =>
      (
        view.button("Dodaj 🔥")?.parentElement?.querySelector("input[type=checkbox]") as
          | HTMLInputElement
          | undefined
      )?.click(),
    );
    await view.click("Usuń 🔥");
    expect(view.calls[1]).toEqual({
      url: `${PATH}/reactions`,
      method: "DELETE",
      body: { emoji: "🔥" },
    });
    await view.unmount();
  });

  test("without Add Reactions a new reaction says why; removing the bot's own still works", async () => {
    const view = mount(message(OLA), info(false, true, false));
    await view.render();
    await view.click("Reaguj");
    await view.click("Dodaj 👍");
    expect(view.notices).toEqual(["Bot nie ma uprawnienia do dodawania reakcji na tym kanale"]);
    expect(view.calls).toEqual([]);
    await act(() =>
      (
        view.button("Dodaj 🔥")?.parentElement?.querySelector("input[type=checkbox]") as
          | HTMLInputElement
          | undefined
      )?.click(),
    );
    await view.click("Usuń 🔥");
    expect(view.calls.map((call) => call.method)).toEqual(["DELETE"]);
    await view.unmount();
  });

  test("the edit form's Pinguj is off each time it opens, also after a ticked save", async () => {
    const view = mount(message(BOT), info(false));
    await view.render();
    const pinguj = () =>
      [...document.querySelectorAll<HTMLInputElement>(".message-edit input[type=checkbox]")].at(-1);
    await view.click("Edytuj");
    await act(() => pinguj()?.click());
    expect(pinguj()?.checked).toBe(true);
    await view.click("Anuluj");
    await view.click("Edytuj");
    expect(pinguj()?.checked).toBe(false);
    await act(() => pinguj()?.click());
    await view.click("Zapisz");
    expect(view.calls[0]?.body).toEqual({ content: "treść", allowMentions: true });
    await view.click("Edytuj");
    expect(pinguj()?.checked).toBe(false);
    await view.unmount();
  });

  test("an edit goes with the mention switch off unless ticked", async () => {
    const view = mount(message(BOT), info(false));
    await view.render();
    await view.click("Edytuj");
    await view.click("Zapisz");
    expect(view.calls).toEqual([
      { url: PATH, method: "PATCH", body: { content: "treść", allowMentions: false } },
    ]);
    await view.unmount();
  });

  test("reply hands the message to the composer; without history it says why", async () => {
    const view = mount(message(OLA), info(false));
    await view.render();
    await view.click("Odpowiedz");
    expect(view.replies.map((m) => m.id)).toEqual(["500000000000000001"]);
    await view.unmount();
    const blind = mount(message(OLA), info(false, false));
    await blind.render();
    await blind.click("Odpowiedz");
    expect(blind.replies).toEqual([]);
    expect(blind.notices[0]).toContain("historii");
    await blind.unmount();
  });

  test("a deleted message has no actions", async () => {
    const view = mount({ ...message(BOT), deletedAt: "2026-11-01T11:00:00.000Z" }, info(true));
    await view.render();
    expect(view.button("Usuń")).toBeUndefined();
    await view.unmount();
  });
});
