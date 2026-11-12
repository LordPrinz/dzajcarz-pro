import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runHealthcheck } from "./healthcheck.ts";
import { startTestServer, type TestServer } from "./testing.ts";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

describe("runHealthcheck", () => {
  test("is 0 against a server that is healthy, so the self-call passes the Host check", async () => {
    started = await startTestServer();
    expect(await runHealthcheck({ WEB_PORT: String(started.port) })).toBe(0);
  });

  test("is 1 when the server answers 503", async () => {
    started = await startTestServer({
      probes: { postgres: async () => false, redis: async () => true },
    });
    expect(await runHealthcheck({ WEB_PORT: String(started.port) })).toBe(1);
  });

  test("is 1 when nothing listens", async () => {
    started = await startTestServer();
    const port = started.port;
    await started.stop();
    started = undefined;
    expect(await runHealthcheck({ WEB_PORT: String(port) })).toBe(1);
  });

  test("is 1 for a WEB_PORT that is not a port", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(await runHealthcheck({ WEB_PORT: "80@example.com" })).toBe(1);
    expect(await runHealthcheck({ WEB_PORT: "8080/x" })).toBe(1);
    error.mockRestore();
  });
});
