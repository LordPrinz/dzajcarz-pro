import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import {
  emptyArchive,
  PUBLIC_ORIGIN,
  startTestServer,
  type TestServer,
  testPage,
} from "../testing.ts";
import {
  allowedHosts,
  binaryBody,
  createGuard,
  GUARDED,
  guardRoutes,
  isSafeMethod,
  normalizeHost,
} from "./guard.ts";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

const post = (t: TestServer, headers: Record<string, string>, body?: string) =>
  fetch(`${t.url}/api/echo`, { method: "POST", headers, body });

const ok = () => Response.json({ ok: true });
const echoRoutes = { "/api/echo": { POST: ok, PUT: ok, PATCH: ok, DELETE: ok, GET: ok } };

describe("Host check", () => {
  test("the public host and the loopback names on the port pass", () => {
    expect(allowedHosts({ publicOrigin: "https://panel.example.com:8443", port: 3000 })).toEqual(
      new Set(["panel.example.com:8443", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]),
    );
  });

  test.each([
    ["Panel.Example.COM", "443", "panel.example.com"],
    ["panel.example.com.", "443", "panel.example.com"],
    ["panel.example.com:443", "443", "panel.example.com"],
    ["panel.example.com.:443", "443", "panel.example.com"],
    ["panel.example.com:80", "443", "panel.example.com:80"],
    ["panel.example.com:80", "80", "panel.example.com"],
    ["panel.example.com..", "443", "panel.example.com."],
    ["[::1]:3000", "443", "[::1]:3000"],
    ["[::1]:443", "443", "[::1]"],
    ["LOCALHOST:3000", "443", "localhost:3000"],
    ["a:b:c", "443", "a:b:c"],
  ])("normalizeHost(%p, %p) is %p", (host, defaultPort, expected) => {
    expect(normalizeHost(host, defaultPort)).toBe(expected);
  });

  test("an https public origin accepts its host in any case, with a trailing dot or an explicit :443", async () => {
    started = await startTestServer();
    for (const host of [
      "PANEL.example.com",
      "panel.example.com.",
      "panel.example.com:443",
      "Panel.Example.Com.:443",
    ]) {
      const response = await fetch(`${started.url}/health`, { headers: { Host: host } });
      expect(response.status).toBe(200);
    }
    for (const host of ["panel.example.com:80", "panel.example.com..", "panel.example.com:4430"]) {
      const response = await fetch(`${started.url}/health`, { headers: { Host: host } });
      expect(response.status).toBe(421);
    }
  });

  test("an http public origin treats :80 as no port", () => {
    const guard = createGuard({
      publicOrigin: "http://localhost:3000",
      port: 3000,
      logger: silentLogger,
    });
    expect(guard.defaultPort).toBe("80");
    expect(
      allowedHosts({ publicOrigin: "http://panel.example.com", port: 3000 }).has(
        "panel.example.com",
      ),
    ).toBe(true);
  });

  test.each(["/api/status", "/health", "/health/live", "/api/guilds"])(
    "%s answers the public host and 421s a foreign one",
    async (path) => {
      started = await startTestServer();
      const good = await fetch(`${started.url}${path}`, { headers: { Host: "panel.example.com" } });
      expect(good.status).not.toBe(421);
      for (const host of [
        "evil.example",
        `127.0.0.1:${started.port + 1}`,
        "panel.example.com.evil",
      ]) {
        const bad = await fetch(`${started.url}${path}`, { headers: { Host: host } });
        expect(bad.status).toBe(421);
      }
    },
  );

  test("a request on the loopback names of the real port passes", async () => {
    started = await startTestServer();
    expect((await fetch(`${started.url}/health`)).status).toBe(200);
    expect(
      (await fetch(`${started.url}/health`, { headers: { Host: `localhost:${started.port}` } }))
        .status,
    ).toBe(200);
  });

  test("a WebSocket upgrade with a foreign Host is refused", async () => {
    started = await startTestServer();
    const response = await fetch(`${started.url}/api/ws`, {
      headers: {
        Host: "evil.example",
        Origin: PUBLIC_ORIGIN,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(response.status).toBe(421);
  });

  test("a path that matches no route is guarded too", async () => {
    started = await startTestServer();
    expect((await fetch(`${started.url}/nope`, { headers: { Host: "evil.example" } })).status).toBe(
      421,
    );
    expect((await fetch(`${started.url}/nope`)).status).toBe(404);
  });
});

describe("Origin check", () => {
  test("a safe method needs no Origin", async () => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    expect((await fetch(`${started.url}/api/echo`)).status).toBe(200);
    expect(isSafeMethod("HEAD")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s with the exact Origin passes",
    async (method) => {
      started = await startTestServer({ extraRoutes: echoRoutes });
      const response = await fetch(`${started.url}/api/echo`, {
        method,
        headers: { ...started.sameOrigin, "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(response.status).toBe(200);
    },
  );

  test.each([
    ["missing", undefined],
    ["null", "null"],
    ["another scheme", "http://panel.example.com"],
    ["another port", "https://panel.example.com:8443"],
    ["another host", "https://evil.example"],
    ["a suffix trick", "https://panel.example.com.evil"],
    ["a trailing slash", "https://panel.example.com/"],
  ])("a state-changing request with an Origin that is %s is 403", async (_label, origin) => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    const headers: Record<string, string> = {
      Host: "panel.example.com",
      "Content-Type": "application/json",
    };
    if (origin !== undefined) headers.Origin = origin;
    expect((await post(started, headers, "{}")).status).toBe(403);
  });

  test("a body that is not JSON is 415", async () => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    const form = await post(
      started,
      { ...started.sameOrigin, "Content-Type": "application/x-www-form-urlencoded" },
      "a=1",
    );
    expect(form.status).toBe(415);
    const text = await post(started, { ...started.sameOrigin, "Content-Type": "text/plain" }, "{}");
    expect(text.status).toBe(415);
  });

  test("a route marked for files takes application/octet-stream and nothing else", async () => {
    started = await startTestServer({
      extraRoutes: { "/api/file": { POST: binaryBody(ok) } },
    });
    const postFile = (headers: Record<string, string>, body: string) =>
      fetch(`${started?.url}/api/file`, { method: "POST", headers, body });
    const sameOrigin = started.sameOrigin;
    expect(
      (await postFile({ ...sameOrigin, "Content-Type": "application/octet-stream" }, "x")).status,
    ).toBe(200);
    for (const type of ["application/json", "multipart/form-data; boundary=x", "text/plain"]) {
      expect((await postFile({ ...sameOrigin, "Content-Type": type }, "x")).status).toBe(415);
    }
    // The Origin and Host checks are the same as for every route.
    expect(
      (
        await postFile(
          {
            Host: sameOrigin.Host,
            Origin: "https://evil.example",
            "Content-Type": "application/octet-stream",
          },
          "x",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await postFile(
          {
            Host: "evil.example",
            Origin: sameOrigin.Origin,
            "Content-Type": "application/octet-stream",
          },
          "x",
        )
      ).status,
    ).toBe(421);
  });

  test("a JSON route refuses a raw file", async () => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    const response = await post(
      started,
      { ...started.sameOrigin, "Content-Type": "application/octet-stream" },
      "x",
    );
    expect(response.status).toBe(415);
  });

  test("JSON with a charset is accepted", async () => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    const response = await post(
      started,
      { ...started.sameOrigin, "Content-Type": "application/json; charset=utf-8" },
      "{}",
    );
    expect(response.status).toBe(200);
  });

  test("a WebSocket upgrade without or with the wrong Origin is 403", async () => {
    started = await startTestServer();
    const upgrade = {
      Host: "panel.example.com",
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    expect((await fetch(`${started.url}/api/ws`, { headers: upgrade })).status).toBe(403);
    expect(
      (
        await fetch(`${started.url}/api/ws`, {
          headers: { ...upgrade, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("guardRoutes", () => {
  test("every handler of the real routes is wrapped, the page and its assets included", async () => {
    started = await startTestServer({ extraRoutes: echoRoutes });
    const { routes } = (await import("../server.ts")).createWebServer(
      {
        publicOrigin: PUBLIC_ORIGIN,
        port: 1,
        bot: { request: async () => ({ ok: false as const, reason: "unavailable" as const }) },
        auditor: { audited: (_request, _action, _context, run) => run() },
        archiveSettings: {
          listGuilds: async () => [],
          dmEnabled: async () => false,
          findGuild: async () => null,
        },
        archive: emptyArchive,
        uploads: { stage: async () => {} },
        live: started.live,
        probes: { postgres: async () => true, redis: async () => true },
        logger: silentLogger,
        page: await testPage(),
      },
      { extraRoutes: echoRoutes },
    );
    const unguarded: string[] = [];
    const wrapped = (handler: unknown) =>
      typeof handler === "function" && (handler as { [GUARDED]?: true })[GUARDED] === true;
    for (const [path, value] of Object.entries(routes)) {
      if (typeof value === "function") {
        if (!wrapped(value)) unguarded.push(path);
      } else if (
        value &&
        typeof value === "object" &&
        Object.keys(value).length > 0 &&
        Object.keys(value).every((key) => /^[A-Z]+$/.test(key))
      ) {
        for (const [method, handler] of Object.entries(value)) {
          if (!wrapped(handler)) unguarded.push(`${method} ${path}`);
        }
      } else {
        unguarded.push(path);
      }
    }
    expect(Object.keys(routes)).toContain("/");
    expect(Object.keys(routes)).toContain("/api/archive/guilds/:guildId");
    expect(Object.keys(routes)).toContain("/api/uploads");
    expect(unguarded).toEqual([]);
  });

  test("a function route and a method map are both wrapped", () => {
    const guard = createGuard({ publicOrigin: PUBLIC_ORIGIN, port: 1, logger: silentLogger });
    const routes = guardRoutes({ "/a": ok, "/b": { GET: ok }, "/c": { index: "html" } }, guard);
    expect((routes["/a"] as { [GUARDED]?: true })[GUARDED]).toBe(true);
    expect((routes["/b"].GET as { [GUARDED]?: true })[GUARDED]).toBe(true);
    expect(routes["/c"]).toEqual({ index: "html" });
  });
});
