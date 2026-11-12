import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRedisPubSub, createRedisStore } from "@dzajcarz/kv";
import { COMMAND_CHANNEL } from "@dzajcarz/web-protocol";
import { RedisClient } from "bun";

// The ACL rules the redis service gives the panel's `web` user, checked against a real Redis: everything the
// panel does works, anything else is refused. A throwaway user per run, so the shared Redis is left as it was.
const adminUrl = Bun.env.TEST_REDIS_URL;
const ACL_FILE = join(import.meta.dir, "../../../infra/redis/web-user.acl");

const user = `test-web-${crypto.randomUUID()}`;
const password = crypto.randomUUID().replaceAll("-", "");
const admin = adminUrl ? new RedisClient(adminUrl) : undefined;
let client: RedisClient | undefined;
let subscriber: RedisClient | undefined;

async function aclRules(): Promise<string[]> {
  const text = await Bun.file(ACL_FILE).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .flatMap((line) => line.trim().split(/\s+/));
}

function asWebUser(): RedisClient {
  const url = new URL(adminUrl ?? "");
  url.username = user;
  url.password = password;
  // Database 0, like WEB_REDIS_URL: any other makes Bun send SELECT, which the user may not run.
  url.pathname = "/0";
  return new RedisClient(url.toString(), { enableOfflineQueue: false });
}

beforeAll(async () => {
  if (!admin) return;
  await admin.send("ACL", ["SETUSER", user, "on", `>${password}`, ...(await aclRules())]);
  client = asWebUser();
  subscriber = asWebUser();
  await client.connect();
  await subscriber.connect();
});

afterAll(async () => {
  client?.close();
  subscriber?.close();
  await admin?.send("ACL", ["DELUSER", user]);
  admin?.close();
});

describe.skipIf(!admin)("the web panel's Redis user", () => {
  test("the rule file holds only channel and command rules, no key patterns", async () => {
    const rules = await aclRules();
    expect(rules).toContain("resetkeys");
    expect(rules).toContain("-@all");
    expect(rules.some((rule) => rule.startsWith("~") || rule === "allkeys")).toBe(false);
  });

  test("can publish and subscribe on the panel's channels and ping", async () => {
    if (!client || !subscriber) return;
    const pubsub = createRedisPubSub({ publisher: client, subscriber });
    const channel = `dzajcarz:web:test:${crypto.randomUUID()}`;
    const received: string[] = [];
    const unsubscribe = await pubsub.subscribe(channel, (message) => received.push(message));
    expect(await pubsub.publish(channel, "hej")).toBe(1);
    const deadline = Date.now() + 2_000;
    while (received.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(received).toEqual(["hej"]);
    await unsubscribe();
    expect(await pubsub.publish(COMMAND_CHANNEL, "{}")).toBeGreaterThanOrEqual(0);
    expect(await createRedisStore(client).ping()).toBe(true);
  });

  test.each([
    ["publish outside dzajcarz:web:*", (c: RedisClient) => c.publish("dzajcarz:other", "x")],
    ["read a key", (c: RedisClient) => c.get("dzajcarz:prefix:guild")],
    ["write a key", (c: RedisClient) => c.set("dzajcarz:web:key", "x")],
    ["list keys", (c: RedisClient) => c.send("KEYS", ["*"])],
    ["flush the database", (c: RedisClient) => c.send("FLUSHALL", [])],
    ["read the config", (c: RedisClient) => c.send("CONFIG", ["GET", "requirepass"])],
    ["change ACLs", (c: RedisClient) => c.send("ACL", ["SETUSER", "x", "on"])],
    ["run a script", (c: RedisClient) => c.send("EVAL", ["return 1", "0"])],
  ])("cannot %s", async (_label, run) => {
    if (!client) return;
    await expect(run(client)).rejects.toThrow(/NOPERM/);
  });

  test("cannot subscribe outside dzajcarz:web:*", async () => {
    const other = asWebUser();
    try {
      await other.connect();
      await expect(other.subscribe("dzajcarz:other", () => {})).rejects.toThrow(/NOPERM/);
    } finally {
      other.close();
    }
  });
});
