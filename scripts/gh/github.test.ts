import { describe, expect, test } from "bun:test";
import { isIssueClosed } from "./github.ts";

const answering = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("isIssueClosed", () => {
  test("is true for a closed issue", async () => {
    expect(await isIssueClosed("t", "acme", "app", 74, answering(200, { state: "closed" }))).toBe(
      true,
    );
  });

  test("is false for an open issue", async () => {
    expect(await isIssueClosed("t", "acme", "app", 74, answering(200, { state: "open" }))).toBe(
      false,
    );
  });

  test("asks for the right issue with the token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ state: "open" }));
    }) as unknown as typeof fetch;
    await isIssueClosed("tok", "acme", "app", 74, spy);
    expect(calls).toEqual([
      { url: "https://api.github.com/repos/acme/app/issues/74", auth: "Bearer tok" },
    ]);
  });

  test("fails loudly when GitHub refuses, instead of treating it as open", async () => {
    await expect(isIssueClosed("t", "acme", "app", 74, answering(403, {}))).rejects.toThrow(
      "Failed to read issue #74: 403",
    );
  });
});
