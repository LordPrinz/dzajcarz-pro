import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { GuildArchiveSettings } from "@dzajcarz/db";
import { createMemoryStore } from "@dzajcarz/kv";
import { createArchivePolicy } from "./archive-policy.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "200000000000000003";
const OTHER = "200000000000000004";

function setup(initial: GuildArchiveSettings | null, dm = false) {
  const state = { guild: initial, dm, lookups: 0, failing: false };
  const cache = createMemoryStore();
  const policy = createArchivePolicy({
    settings: {
      async findGuild() {
        state.lookups++;
        if (state.failing) throw new Error("postgres down");
        return state.guild;
      },
      async dmEnabled() {
        state.lookups++;
        if (state.failing) throw new Error("postgres down");
        return state.dm;
      },
    },
    cache,
    logger: silentLogger,
  });
  return { policy, state, cache };
}

const on = (excludedChannelIds: string[] = []): GuildArchiveSettings => ({
  guildId: GUILD,
  enabled: true,
  excludedChannelIds,
});

describe("archive policy", () => {
  test("a server without settings is not archived", async () => {
    const { policy } = setup(null);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
  });

  test("a switched-off server is not archived", async () => {
    const { policy } = setup({ ...on(), enabled: false });
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
  });

  test("an enabled server is archived except its excluded channels and their threads", async () => {
    const { policy } = setup(on([CHANNEL]));
    expect(await policy.archives(GUILD, [OTHER, null])).toBe(true);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
    expect(await policy.archives(GUILD, [THREAD, CHANNEL])).toBe(false);
  });

  test("DMs follow the DM switch", async () => {
    expect(await setup(on(), false).policy.archives(null, [CHANNEL, null])).toBe(false);
    expect(await setup(null, true).policy.archives(null, [CHANNEL, null])).toBe(true);
  });

  test("the settings are cached, and a change applies after forgetting them", async () => {
    const { policy, state } = setup(null);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
    expect(state.lookups).toBe(1);

    state.guild = on();
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
    await policy.forgetGuild(GUILD);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(true);

    expect(await policy.archives(null, [CHANNEL, null])).toBe(false);
    state.dm = true;
    await policy.forgetDm();
    expect(await policy.archives(null, [CHANNEL, null])).toBe(true);
  });

  test("when Postgres cannot be read the archive is off", async () => {
    const { policy, state } = setup(on());
    state.failing = true;
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
  });

  test("an unreadable cached value counts as off", async () => {
    const { policy, cache } = setup(on());
    await cache.set(`guild:${GUILD}:archive`, "{nope", 60_000);
    expect(await policy.archives(GUILD, [CHANNEL, null])).toBe(false);
  });
});
