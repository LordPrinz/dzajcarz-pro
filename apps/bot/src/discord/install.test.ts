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
    // View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Manage Channels,
    // Manage Roles, Move Members, Connect, Speak, Ban Members, Kick Members, Moderate Members, Add Reactions.
    const bits = [10n, 11n, 14n, 16n, 13n, 4n, 28n, 24n, 20n, 21n, 2n, 1n, 40n, 6n];
    const expected = bits.reduce((sum, bit) => sum | (1n << bit), 0n);
    expect(expected).toBe(1099800079446n);
    expect(url.searchParams.get("permissions")).toBe(expected.toString());
    expect(links.guild).toContain("scope=bot+applications.commands");
  });

  test("user install only needs applications.commands", () => {
    const url = new URL(links.user);
    expect(url.searchParams.get("integration_type")).toBe("1");
    expect(url.searchParams.get("scope")).toBe("applications.commands");
    expect(url.searchParams.has("permissions")).toBe(false);
  });
});
