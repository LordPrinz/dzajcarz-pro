import { describe, expect, test } from "bun:test";
import {
  backoffDelay,
  type ConnectionState,
  connectSocket,
  type SocketOptions,
  type StatusMessage,
  sessionExpired,
} from "./socket.ts";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readyState = 0;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function setup(isExpired: () => Promise<boolean> = async () => false) {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const statuses: StatusMessage[] = [];
  const events: unknown[] = [];
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  const options: SocketOptions = {
    url: "ws://x/api/ws",
    onStatus: (message) => statuses.push(message),
    onState: (state) => states.push(state),
    onEvent: (data) => events.push(data),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    isExpired,
    schedule: (callback, ms) => {
      delays.push(ms);
      pending = callback;
    },
  };
  const socket = connectSocket(options);
  return {
    stop: socket.stop,
    watch: socket.watch,
    watchMusic: socket.watchMusic,
    events,
    sockets,
    states,
    statuses,
    delays,
    fire: () => pending?.(),
  };
}

const flush = () => Bun.sleep(0);

describe("backoffDelay", () => {
  test("doubles from 1 s up to 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("connectSocket", () => {
  test("passes status messages on, other JSON to onEvent, and ignores what is not JSON", () => {
    const t = setup();
    const message: StatusMessage = {
      event: "bot.status",
      online: true,
      payload: null,
      lastSeen: 1,
    };
    t.sockets[0]?.onopen?.();
    t.sockets[0]?.onmessage?.({ data: JSON.stringify(message) });
    t.sockets[0]?.onmessage?.({ data: "not json" });
    t.sockets[0]?.onmessage?.({ data: JSON.stringify({ event: "other" }) });
    expect(t.statuses).toEqual([message]);
    expect(t.events).toEqual([{ event: "other" }]);
    expect(t.states).toEqual(["connecting", "open"]);
  });

  test("watch subscribes one channel at a time and again after a reconnect", async () => {
    const t = setup();
    const first = t.sockets[0];
    if (!first) throw new Error("no socket");
    // Not open yet: nothing is sent, the open sends it.
    t.watch("200000000000000001");
    expect(first.sent).toEqual([]);
    first.readyState = 1;
    first.onopen?.();
    t.watch("200000000000000002");
    t.watch("200000000000000002");
    expect(first.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "subscribe", channelId: "200000000000000001" },
      { type: "unsubscribe", channelId: "200000000000000001" },
      { type: "subscribe", channelId: "200000000000000002" },
    ]);
    first.onclose?.();
    await flush();
    t.fire();
    const second = t.sockets[1];
    if (!second) throw new Error("no second socket");
    second.readyState = 1;
    second.onopen?.();
    expect(second.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "subscribe", channelId: "200000000000000002" },
    ]);
    t.watch(null);
    expect(JSON.parse(second.sent.at(-1) ?? "")).toEqual({
      type: "unsubscribe",
      channelId: "200000000000000002",
    });
  });

  test("watchMusic follows one server's player, next to the channel, also after a reconnect", async () => {
    const t = setup();
    const first = t.sockets[0];
    if (!first) throw new Error("no socket");
    first.readyState = 1;
    first.onopen?.();
    t.watch("200000000000000001");
    t.watchMusic("100000000000000001");
    t.watchMusic("100000000000000002");
    expect(first.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "subscribe", channelId: "200000000000000001" },
      { type: "subscribe", musicGuildId: "100000000000000001" },
      { type: "unsubscribe", musicGuildId: "100000000000000001" },
      { type: "subscribe", musicGuildId: "100000000000000002" },
    ]);
    first.onclose?.();
    await flush();
    t.fire();
    const second = t.sockets[1];
    if (!second) throw new Error("no second socket");
    second.readyState = 1;
    second.onopen?.();
    expect(second.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "subscribe", channelId: "200000000000000001" },
      { type: "subscribe", musicGuildId: "100000000000000002" },
    ]);
    t.watchMusic(null);
    expect(JSON.parse(second.sent.at(-1) ?? "")).toEqual({
      type: "unsubscribe",
      musicGuildId: "100000000000000002",
    });
  });

  test("reconnects with a doubling delay, and a successful open starts the count again", async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      t.sockets[i]?.onclose?.();
      await flush();
      t.fire();
    }
    expect(t.delays).toEqual([1_000, 2_000, 4_000]);
    expect(t.sockets).toHaveLength(4);

    t.sockets[3]?.onopen?.();
    t.sockets[3]?.onclose?.();
    await flush();
    expect(t.delays).toEqual([1_000, 2_000, 4_000, 1_000]);
    expect(t.states.at(-1)).toBe("reconnecting");
  });

  test("a 401 or an opaque redirect from /api/status stops reconnecting for good", async () => {
    const t = setup(async () => true);
    t.sockets[0]?.onclose?.();
    await flush();
    expect(t.states.at(-1)).toBe("expired");
    expect(t.delays).toEqual([]);
    expect(t.sockets).toHaveLength(1);
  });

  test("stop closes the socket and prevents a reconnect", async () => {
    const t = setup();
    t.stop();
    expect(t.sockets[0]?.closed).toBe(true);
    t.sockets[0]?.onclose?.();
    await flush();
    expect(t.delays).toEqual([]);
  });
});

describe("sessionExpired", () => {
  const fakeFetch = (response: { status: number; type: string }) =>
    (async () => response) as unknown as typeof fetch;

  test("is true for a 401 and for an opaque redirect", async () => {
    expect(await sessionExpired(fakeFetch({ status: 401, type: "basic" }))).toBe(true);
    expect(await sessionExpired(fakeFetch({ status: 0, type: "opaqueredirect" }))).toBe(true);
  });

  test("is false for an answer, an error status or no network", async () => {
    expect(await sessionExpired(fakeFetch({ status: 200, type: "basic" }))).toBe(false);
    expect(await sessionExpired(fakeFetch({ status: 503, type: "basic" }))).toBe(false);
    expect(
      await sessionExpired((async () => {
        throw new TypeError("network");
      }) as unknown as typeof fetch),
    ).toBe(false);
  });
});
