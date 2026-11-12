import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { keepConnected } from "./redis.ts";

interface FakeClient {
  onconnect: (() => void) | null;
  onclose: ((error: Error) => void) | null;
  connects: number;
  closes: number;
  connect(): Promise<void>;
  close(): void;
}

/** Fires `onconnect` the way Bun does after a successful connect, and `onclose` when closed. */
function fakeClient(): FakeClient & RedisClient {
  const client: FakeClient = {
    onconnect: null,
    onclose: null,
    connects: 0,
    closes: 0,
    async connect() {
      client.connects += 1;
      client.onconnect?.();
    },
    close() {
      client.closes += 1;
      client.onclose?.(new Error("closed"));
    },
  };
  return client as FakeClient & RedisClient;
}

const warnings: string[] = [];
const log = { warn: (message: string) => void warnings.push(message) };

describe("keepConnected", () => {
  test("a number as the third argument is the retry delay", async () => {
    const client = fakeClient();
    keepConnected(client, log, 10);
    expect(client.connects).toBe(1);
    client.onclose?.(new Error("down"));
    await Bun.sleep(40);
    expect(client.connects).toBe(2);
  });

  test("onConnect runs after the first connect, after a retry and after a reconnect Bun did itself", async () => {
    const client = fakeClient();
    let calls = 0;
    keepConnected(client, log, {
      retryMs: 10,
      onConnect: () => {
        calls += 1;
      },
    });
    await Bun.sleep(5);
    expect(calls).toBe(1);

    client.onclose?.(new Error("down"));
    await Bun.sleep(40);
    expect(calls).toBe(2);

    // Bun's own autoReconnect never reaches onclose, only onconnect.
    client.onconnect?.();
    await Bun.sleep(5);
    expect(calls).toBe(3);
  });

  test("a throwing onConnect is logged and the connection is closed so the retry runs it again", async () => {
    warnings.length = 0;
    const client = fakeClient();
    let calls = 0;
    keepConnected(client, log, {
      retryMs: 10,
      onConnect: () => {
        calls += 1;
        if (calls === 1) throw new Error("subscribe failed");
      },
    });
    await Bun.sleep(60);
    expect(client.closes).toBe(1);
    expect(warnings).toContain("Redis connect hook failed; reconnecting");
    expect(calls).toBe(2);
  });
});
