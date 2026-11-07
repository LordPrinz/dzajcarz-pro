import { describe, expect, test } from "bun:test";
import { createInstallLinks } from "./install.ts";

describe("createInstallLinks", () => {
  const links = createInstallLinks("123456789012345678");

  test("guild install asks for the bot scope and the permissions from CONTRIBUTING", () => {
    const url = new URL(links.guild);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123456789012345678");
    expect(url.searchParams.get("integration_type")).toBe("0");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    // View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles,
    // Move Members, Connect, Speak.
    expect(url.searchParams.get("permissions")).toBe("288443408");
    expect(links.guild).toContain("scope=bot+applications.commands");
  });

  test("user install only needs applications.commands", () => {
    const url = new URL(links.user);
    expect(url.searchParams.get("integration_type")).toBe("1");
    expect(url.searchParams.get("scope")).toBe("applications.commands");
    expect(url.searchParams.has("permissions")).toBe(false);
  });
});
