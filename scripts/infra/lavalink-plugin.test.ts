import { describe, expect, test } from "bun:test";

// The plugin version lives in three places: what Lavalink loads, what the init step verifies, and the
// hash recorded in ADR 4. A bump that misses one either fails the start or loads an unchecked jar.
const root = new URL("../../", import.meta.url);
const read = (path: string) => Bun.file(new URL(path, root)).text();

describe("YouTube plugin pin", () => {
  test("application.yml, the checksum file and ADR 4 name the same jar and hash", async () => {
    const config = await read("infra/lavalink/application.yml");
    const checksum = (await read("infra/lavalink/youtube-plugin.sha256")).trim();
    const adr = await read("docs/adr/0004-lavalink-for-audio.md");

    const version = config.match(/dev\.lavalink\.youtube:youtube-plugin:([\w.-]+)"/)?.[1];
    expect(version).toBeDefined();
    expect(checksum).toMatch(new RegExp(`^[0-9a-f]{64}  youtube-plugin-${version}\\.jar$`));
    expect(adr).toContain(checksum);
  });

  test("the init script downloads from the repository application.yml points at", async () => {
    const config = await read("infra/lavalink/application.yml");
    const script = await read("infra/lavalink/fetch-plugin.sh");
    const snapshot = /youtube-plugin:[^\n]*\n\s*snapshot: true/.test(config);
    const repository = script.match(/^REPOSITORY=https:\/\/maven\.lavalink\.dev\/(\w+)\//m)?.[1];
    expect(repository).toBe(snapshot ? "snapshots" : "releases");
  });
});
