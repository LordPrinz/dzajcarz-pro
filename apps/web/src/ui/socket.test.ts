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
  close() {
    this.closed = true;
  }
}

function setup(isExpired: () => Promise<boolean> = async () => false) {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const statuses: StatusMessage[] = [];
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  const options: SocketOptions = {
    url: "ws://x/api/ws",
    onStatus: (message) => statuses.push(message),
    onState: (state) => states.push(state),
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
  return {
    stop: connectSocket(options),
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
  test("passes status messages on and ignores anything else", () => {
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
    expect(t.states).toEqual(["connecting", "open"]);
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
