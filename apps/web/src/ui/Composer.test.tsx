import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer, type ComposerProps, isSendShortcut } from "./Composer.tsx";
import type { PanelMessage } from "./reading-api.ts";
import type { ChannelInfo } from "./write-api.ts";

const CHANNEL = "200000000000000002";
const GUILD = "100000000000000001";
const channel = { id: CHANNEL, guildId: GUILD, name: "ogólny" };
const info: ChannelInfo = {
  guildId: GUILD,
  botUserId: "300000000000000001",
  uploadLimit: 1024,
  can: { send: true, attach: true, history: true, react: true, manage: false },
};

type Call = { url: string; method: string; body: unknown; type: string | null };

/** A fetch that answers each call with what `answer` returns, recording every call. */
function recordingFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
    const call = {
      url: input,
      method: init.method ?? "GET",
      body,
      type: headers.get("content-type"),
    };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return calls;
}

let originalFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
});
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Mounts the composer with `draft` as the saved text of the channel. React's DOM was loaded before happy-dom
 * registered, so typing cannot be simulated; the saved draft is how text gets in.
 */
function mount(props: Partial<ComposerProps> = {}, draft?: string) {
  if (draft !== undefined) localStorage.setItem(`dzajcarz:draft:${CHANNEL}`, draft);
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let cancelled = 0;
  const render = (next: Partial<ComposerProps> = {}) =>
    act(() => {
      root ??= createRoot(container);
      root.render(
        <Composer
          channel={channel}
          info={info}
          replyTo={null}
          onCancelReply={() => cancelled++}
          {...props}
          {...next}
        />,
      );
    });
  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;
  const checkbox = () =>
    [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")][0];
  const submit = () =>
    act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Bun.sleep(0);
    });
  const attach = (files: File[]) =>
    act(() => {
      const input = container.querySelector("input[type=file]") as HTMLInputElement;
      Object.defineProperty(input, "files", { configurable: true, value: files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const alert = () => container.querySelector("[role=alert]")?.textContent ?? null;
  const unmount = () => act(() => root?.unmount());
  return {
    container,
    render,
    textarea,
    checkbox,
    submit,
    attach,
    alert,
    unmount,
    cancelled: () => cancelled,
  };
}

const sent = (messageId = "500000000000000001") =>
  Response.json({ status: "ok", messageId }, { status: 201 });

describe("Composer", () => {
  test("the Pinguj switch is off by default and the message goes without mentions", async () => {
    const calls = recordingFetch(() => sent());
    const view = mount({}, "hej <@300000000000000002>");
    await view.render();
    expect(view.checkbox()?.checked).toBe(false);
    await view.submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `/api/channels/${CHANNEL}/messages`,
      method: "POST",
      body: { content: "hej <@300000000000000002>", allowMentions: false },
    });
    expect(view.textarea().value).toBe("");
    await view.unmount();
  });

  test("Ctrl+Enter and Cmd+Enter send, a plain Enter makes a new line", () => {
    expect(isSendShortcut({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSendShortcut({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSendShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSendShortcut({ key: "a", ctrlKey: true, metaKey: false })).toBe(false);
  });

  test("sends with the switch when it is ticked, and the reply", async () => {
    const calls = recordingFetch(() => sent());
    const reply = {
      id: "500000000000000009",
      author: { username: "ola", displayName: null },
      content: "co?",
    };
    const view = mount({ replyTo: reply as PanelMessage }, "tak");
    await view.render();
    await act(() => view.checkbox()?.click());
    await view.submit();
    expect(calls[0]?.body).toMatchObject({
      content: "tak",
      allowMentions: true,
      replyTo: "500000000000000009",
    });
    expect(view.cancelled()).toBe(1);
    await view.unmount();
  });

  test("when the bot is down the draft stays, also in storage, and a retry keeps the nonce", async () => {
    let down = true;
    const calls = recordingFetch(() =>
      down ? Response.json({ error: "bot_unavailable" }, { status: 503 }) : sent(),
    );
    const view = mount({}, "ważne");
    await view.render();
    await view.submit();
    expect(view.alert()).toBe("Bot niedostępny, nic nie wysłano");
    expect(view.textarea().value).toBe("ważne");
    expect(localStorage.getItem(`dzajcarz:draft:${CHANNEL}`)).toBe("ważne");
    down = false;
    await view.submit();
    const [first, second] = calls.map((call) => (call.body as { nonce: string }).nonce);
    expect(second).toBe(first);
    expect(view.textarea().value).toBe("");
    expect(localStorage.getItem(`dzajcarz:draft:${CHANNEL}`)).toBeNull();
    await view.unmount();
  });

  test("a changed draft gets a new nonce", async () => {
    const calls = recordingFetch(() => Response.json({ error: "bot_timeout" }, { status: 503 }));
    const view = mount({}, "raz");
    await view.render();
    await view.submit();
    await act(() => view.checkbox()?.click());
    await view.submit();
    const [first, second] = calls.map((call) => (call.body as { nonce: string }).nonce);
    expect(second).not.toBe(first);
    await view.unmount();
  });

  test("replying to another message makes a new nonce", async () => {
    const calls = recordingFetch(() => Response.json({ error: "bot_timeout" }, { status: 503 }));
    const reply = (id: string) =>
      ({ id, author: { username: "ola", displayName: null }, content: "co?" }) as PanelMessage;
    const view = mount({ replyTo: reply("500000000000000009") }, "tak");
    await view.render();
    await view.submit();
    await view.render({ replyTo: reply("500000000000000008") });
    await view.submit();
    await view.render({ replyTo: null });
    await view.submit();
    const nonces = calls.map((call) => (call.body as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(3);
    await view.unmount();
  });

  test("what is changed while a send is in flight is kept, and the next send is a new message", async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const calls = recordingFetch(() => sent());
    const slow = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      const first = calls.length === 0;
      const answer = slow(input, init);
      return first ? pending : answer;
    }) as unknown as typeof fetch;
    const reply = (id: string) =>
      ({ id, author: { username: "ola", displayName: null }, content: "co?" }) as PanelMessage;
    const view = mount({ replyTo: reply("500000000000000009") }, "tak");
    await view.render();
    await view.submit();
    // Picked while the first message is on its way.
    await act(() => view.checkbox()?.click());
    await view.render({ replyTo: reply("500000000000000008") });
    await act(async () => {
      finish(sent());
      await Bun.sleep(0);
    });
    expect(view.checkbox()?.checked).toBe(true);
    expect(view.cancelled()).toBe(0);
    expect(view.textarea().value).toBe("");
    await view.unmount();
  });

  test("a refusal shows its reason and keeps the draft", async () => {
    recordingFetch(() => Response.json({ error: "rejected", reason: "no_send" }, { status: 422 }));
    const view = mount({}, "hej");
    await view.render();
    await view.submit();
    expect(view.alert()).toBe("Bot nie ma uprawnienia do pisania na tym kanale");
    expect(view.textarea().value).toBe("hej");
    await view.unmount();
  });

  test("the draft of a channel comes back after a reload", async () => {
    const view = mount({}, "zapisane");
    await view.render();
    expect(view.textarea().value).toBe("zapisane");
    await view.unmount();
  });

  test("a file over the channel's limit is refused before any upload", async () => {
    const calls = recordingFetch(() => sent());
    const view = mount();
    await view.render();
    await view.attach([new File([new Uint8Array(2048)], "duzy.png")]);
    expect(view.alert()).toContain("duzy.png");
    expect(view.alert()).toContain("limit");
    expect(view.container.textContent).not.toContain("Usuń duzy.png");
    expect(calls).toEqual([]);
    await view.unmount();
  });

  test("files are uploaded raw, then sent by id", async () => {
    const calls = recordingFetch((call) =>
      call.url.startsWith("/api/uploads")
        ? Response.json({ id: "11111111-1111-4111-8111-111111111111" }, { status: 201 })
        : sent(),
    );
    const view = mount();
    await view.render();
    await view.attach([new File(["abc"], "a.txt")]);
    await view.submit();
    expect(calls.map((call) => [call.method, call.url.split("?")[0], call.type])).toEqual([
      ["POST", "/api/uploads", "application/octet-stream"],
      ["POST", `/api/channels/${CHANNEL}/messages`, "application/json"],
    ]);
    expect(calls[0]?.url).toBe("/api/uploads?name=a.txt");
    expect(calls[1]?.body).toMatchObject({
      content: "",
      attachmentIds: ["11111111-1111-4111-8111-111111111111"],
    });
    await view.unmount();
  });

  test("without the right to write, the composer says so and sends nothing", async () => {
    const calls = recordingFetch(() => sent());
    const view = mount({ info: { ...info, can: { ...info.can, send: false } } }, "hej");
    await view.render();
    expect(view.container.textContent).toContain("Bot nie ma uprawnienia do pisania");
    expect(view.textarea().disabled).toBe(true);
    await view.submit();
    expect(calls).toEqual([]);
    await view.unmount();
  });
});
