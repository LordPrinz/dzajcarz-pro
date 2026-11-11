import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { MAX_BODY_BYTES, readJson } from "./json.ts";

const Body = z.object({ content: z.string().min(1) });
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://panel.example.com/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

describe("readJson", () => {
  test("returns the parsed body", async () => {
    expect(await readJson(post('{"content":"hej"}'), Body)).toEqual({
      ok: true,
      data: { content: "hej" },
    });
  });

  test("400 invalid_json for text that is not JSON", async () => {
    const result = await readJson(post("{nope"), Body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error: "invalid_json" });
    }
  });

  test("400 invalid_body with the zod problem for JSON that does not fit", async () => {
    const result = await readJson(post('{"content":""}'), Body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_body");
      expect(body.message).toContain("content");
    }
  });

  test("413 for a body over the limit, declared or not", async () => {
    const big = JSON.stringify({ content: "x".repeat(MAX_BODY_BYTES) });
    const result = await readJson(post(big), Body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);

    const lying = await readJson(post(big, { "Content-Length": "5" }), Body);
    expect(lying.ok).toBe(false);
    if (!lying.ok) expect(lying.response.status).toBe(413);
  });
});
