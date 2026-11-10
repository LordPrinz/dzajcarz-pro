import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createScheduledSongRepository } from "./scheduled-songs.ts";
import { createTestDatabase } from "./testing.ts";

const testDb = createTestDatabase();
const sql = testDb?.sql;

beforeAll(async () => {
  await testDb?.setup();
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  if (sql) await sql`TRUNCATE scheduled_song_config, scheduled_song_exclusion`;
});

describe.skipIf(!sql)("scheduled song repository", () => {
  const repo = () => createScheduledSongRepository(sql as SQL);
  const guild = "1234567890123456789";

  test("a guild without a choice has no song", async () => {
    expect(await repo().getSong(guild)).toBeNull();
  });

  test("setSong stores the song, a second call replaces it, clearSong forgets it", async () => {
    await repo().setSong(guild, "lato_z_radiem");
    await repo().setSong(guild, "icona_pop");
    expect(await repo().getSong(guild)).toBe("icona_pop");
    expect(await repo().clearSong(guild)).toBe(true);
    expect(await repo().getSong(guild)).toBeNull();
    expect(await repo().clearSong(guild)).toBe(false);
  });

  test("excluded channels are listed per guild in the order they were added", async () => {
    expect(await repo().addExcluded(guild, "30")).toBe(true);
    expect(await repo().addExcluded(guild, "10")).toBe(true);
    expect(await repo().addExcluded("999", "20")).toBe(true);
    expect(await repo().listExcluded(guild)).toEqual(["30", "10"]);
  });

  test("excluding a channel twice reports false and keeps one row", async () => {
    await repo().addExcluded(guild, "30");
    expect(await repo().addExcluded(guild, "30")).toBe(false);
    expect(await repo().listExcluded(guild)).toEqual(["30"]);
  });

  test("removeExcluded reports whether the channel was excluded", async () => {
    await repo().addExcluded(guild, "30");
    expect(await repo().removeExcluded(guild, "30")).toBe(true);
    expect(await repo().removeExcluded(guild, "30")).toBe(false);
    expect(await repo().listExcluded(guild)).toEqual([]);
  });
});
