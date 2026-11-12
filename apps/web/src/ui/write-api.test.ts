import { describe, expect, test } from "bun:test";
import {
  checkFiles,
  debounce,
  MAX_UPLOAD_BYTES,
  newNonce,
  normalizeEmoji,
  openDm,
  react,
  searchMembers,
  sendMessage,
  WRITE_ERRORS,
  type WriteError,
} from "./write-api.ts";

const CHANNEL = "200000000000000002";
const draft = { content: "hej", allowMentions: false, nonce: "abc" };

const answering =
  (response: Response, seen: { url: string; init?: RequestInit }[] = []) =>
  async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return response;
  };

describe("errors", () => {
  test.each([
    [Response.json({ error: "bot_unavailable" }, { status: 503 }), "unavailable"],
    [Response.json({ error: "bot_timeout" }, { status: 503 }), "unavailable"],
    [Response.json({ error: "audit_unavailable" }, { status: 503 }), "audit_unavailable"],
    [Response.json({ error: "uploads_busy" }, { status: 429 }), "uploads_busy"],
    [Response.json({ error: "uploads_full" }, { status: 503 }), "uploads_full"],
    [Response.json({ error: "rejected", reason: "dm_not_own" }, { status: 422 }), "dm_not_own"],
    [Response.json({ error: "rejected", reason: "no_manage" }, { status: 422 }), "no_manage"],
    [Response.json({ error: "rejected", reason: "something_new" }, { status: 422 }), "error"],
    [Response.json({ error: "invalid_body" }, { status: 400 }), "invalid"],
    [new Response("oops", { status: 500 }), "error"],
  ] satisfies [Response, WriteError][])(
    "an answer maps to its message",
    async (response, error) => {
      expect(await sendMessage(CHANNEL, draft, answering(response))).toEqual({ ok: false, error });
    },
  );

  test("a network failure is an error, not a throw", async () => {
    const failing = async () => {
      throw new TypeError("offline");
    };
    expect(await sendMessage(CHANNEL, draft, failing)).toEqual({ ok: false, error: "error" });
  });

  test("every error has a Polish text", () => {
    for (const text of Object.values(WRITE_ERRORS)) expect(text.length).toBeGreaterThan(0);
  });
});

describe("requests", () => {
  test("a reaction goes to the message's reactions, removal with DELETE", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetcher = answering(Response.json({ status: "ok" }), seen);
    await react(CHANNEL, "500000000000000001", "👍", false, fetcher);
    await react(CHANNEL, "500000000000000001", "👍", true, fetcher);
    expect(seen.map(({ url, init }) => [init?.method, url, init?.body])).toEqual([
      ["PUT", `/api/channels/${CHANNEL}/messages/500000000000000001/reactions`, '{"emoji":"👍"}'],
      [
        "DELETE",
        `/api/channels/${CHANNEL}/messages/500000000000000001/reactions`,
        '{"emoji":"👍"}',
      ],
    ]);
  });

  test("member search and opening a DM", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    await searchMembers("ola", null, answering(Response.json({ members: [] }), seen));
    await searchMembers(
      "ola",
      "100000000000000001",
      answering(Response.json({ members: [] }), seen),
    );
    await openDm("300000000000000002", answering(Response.json({ status: "ok" }), seen));
    expect(seen.map(({ url }) => url)).toEqual([
      "/api/members?q=ola",
      "/api/members?q=ola&guild=100000000000000001",
      "/api/dms/open",
    ]);
    expect(seen[2]?.init?.body).toBe('{"userId":"300000000000000002"}');
  });
});

describe("normalizeEmoji", () => {
  test.each([
    ["<:dzajco:123456789012345678>", "dzajco:123456789012345678"],
    ["<a:taniec:123456789012345678>", "a:taniec:123456789012345678"],
    [" 👍 ", "👍"],
    ["dzajco:123456789012345678", "dzajco:123456789012345678"],
  ])("%s -> %s", (input, output) => {
    expect(normalizeEmoji(input)).toBe(output);
  });
});

describe("checkFiles", () => {
  const file = (name: string, size: number) => ({ name, size });

  test("files within the limit pass", () => {
    expect(checkFiles([file("a", 10), file("b", 10)], 20)).toBeNull();
  });

  test("a file over the channel's limit is named", () => {
    expect(checkFiles([file("duzy.png", 11)], 10)).toContain("duzy.png");
  });

  test("more than ten files, an empty one, or too much in total are refused", () => {
    expect(
      checkFiles(
        Array.from({ length: 11 }, (_, i) => file(`${i}`, 1)),
        10,
      ),
    ).toBe(WRITE_ERRORS.too_many_files);
    expect(checkFiles([file("pusty", 0)], 10)).not.toBeNull();
    // Each fits the channel's limit, together they do not.
    expect(checkFiles([file("a", 6), file("b", 6)], 10)).toContain("razem");
    const half = MAX_UPLOAD_BYTES / 2 + 1;
    expect(checkFiles([file("a", half), file("b", half)], MAX_UPLOAD_BYTES)).toContain("razem");
  });
});

test("a nonce is at most 25 letters and digits, new each time", () => {
  const nonce = newNonce();
  expect(nonce).toMatch(/^[A-Za-z0-9]{1,25}$/);
  expect(newNonce()).not.toBe(nonce);
});

test("debounce runs once, with the last arguments, after the calls stop", async () => {
  const seen: string[] = [];
  const typed = debounce((text: string) => seen.push(text), 20);
  typed.call("o");
  typed.call("ol");
  typed.call("ola");
  await Bun.sleep(5);
  expect(seen).toEqual([]);
  await Bun.sleep(40);
  expect(seen).toEqual(["ola"]);
  typed.call("x");
  typed.cancel();
  await Bun.sleep(40);
  expect(seen).toEqual(["ola"]);
});
