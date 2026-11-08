import { describe, expect, test } from "bun:test";
import { downloadDiscordFile } from "./download.ts";

const CDN = "https://cdn.discordapp.com/attachments/1/2/a.png";

function fake(body: ConstructorParameters<typeof Response>[0], init?: ResponseInit) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFile = (async (url: string, options?: RequestInit) => {
    calls.push({ url, init: options });
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return { calls, fetchFile };
}

describe("downloadDiscordFile", () => {
  test("returns the bytes of a file on the Discord CDN and refuses redirects", async () => {
    const { calls, fetchFile } = fake(new Uint8Array([1, 2, 3]));
    expect(await downloadDiscordFile(CDN, 10, fetchFile)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    "http://cdn.discordapp.com/a.png",
    "https://evil.example/a.png",
    "https://cdn.discordapp.com.evil.example/a.png",
    "https://user:pw@cdn.discordapp.com/a.png",
    "https://cdn.discordapp.com:8443/a.png",
    "not a url",
  ])("never contacts %s", async (url) => {
    const { calls, fetchFile } = fake(new Uint8Array([1]));
    expect(await downloadDiscordFile(url, 10, fetchFile)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a body over the limit is dropped, declared or not", async () => {
    const declared = fake(new Uint8Array(4), { headers: { "content-length": "999" } });
    expect(await downloadDiscordFile(CDN, 10, declared.fetchFile)).toBeNull();
    const streamed = fake(new Uint8Array(11));
    expect(await downloadDiscordFile(CDN, 10, streamed.fetchFile)).toBeNull();
  });

  test("an error status, a network failure and a timeout all give null", async () => {
    const missing = fake("nope", { status: 404 });
    expect(await downloadDiscordFile(CDN, 10, missing.fetchFile)).toBeNull();
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await downloadDiscordFile(CDN, 10, failing)).toBeNull();
    const hanging = ((_url: string, options?: RequestInit) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await downloadDiscordFile(CDN, 10, hanging, 20)).toBeNull();
  });
});
