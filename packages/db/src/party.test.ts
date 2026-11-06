import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createPartyRepository } from "./party.ts";
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
  if (sql) await sql`TRUNCATE party_channel, party_area`;
});

describe.skipIf(!sql)("party repository", () => {
  const repo = () => createPartyRepository(sql as SQL);
  const guildId = "1234567890123456789";
  const area = { guildId, categoryId: "301", joinChannelId: "401" };
  const channel = { channelId: "501", guildId, ownerId: "601", joinChannelId: "401" };

  test("an area is found by join channel and by category", async () => {
    await repo().addArea(area);
    expect(await repo().findAreaByJoinChannel("401")).toEqual(area);
    expect(await repo().findAreaByCategory("301")).toEqual(area);
    expect(await repo().findAreaByJoinChannel("999")).toBeNull();
    expect(await repo().listAreas(guildId)).toEqual([area]);
    expect(await repo().listAreas("5555555555555555555")).toEqual([]);
  });

  test("a category holds only one area", async () => {
    await repo().addArea(area);
    await expect(repo().addArea({ ...area, joinChannelId: "402" })).rejects.toThrow();
  });

  test("a channel is found by id and by owner", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    expect(await repo().findChannel("501")).toEqual(channel);
    expect(await repo().findChannelByOwner(guildId, "601")).toEqual(channel);
    expect(await repo().findChannelByOwner(guildId, "602")).toBeNull();
    expect(await repo().findChannelByOwner("5555555555555555555", "601")).toBeNull();
    expect(await repo().listChannelsOfArea("401")).toEqual([channel]);
    expect(await repo().listChannels()).toEqual([channel]);
  });

  test("a member owns one channel per guild, but may own one in another guild", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    await expect(repo().addChannel({ ...channel, channelId: "502" })).rejects.toThrow();
    await repo().addArea({ guildId: "7", categoryId: "311", joinChannelId: "411" });
    await repo().addChannel({
      channelId: "503",
      guildId: "7",
      ownerId: "601",
      joinChannelId: "411",
    });
  });

  test("a channel needs an existing area", async () => {
    await expect(repo().addChannel(channel)).rejects.toThrow();
  });

  test("deleting an area removes its channels and leaves other areas alone", async () => {
    await repo().addArea(area);
    await repo().addArea({ guildId, categoryId: "302", joinChannelId: "402" });
    await repo().addChannel(channel);
    await repo().addChannel({ ...channel, channelId: "502", ownerId: "602", joinChannelId: "402" });
    expect(await repo().deleteArea("401")).toBe(true);
    expect(await repo().findChannel("501")).toBeNull();
    expect(await repo().findChannel("502")).not.toBeNull();
    expect(await repo().deleteArea("401")).toBe(false);
  });

  test("deleteChannel reports whether there was a row", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    expect(await repo().deleteChannel("501")).toBe(true);
    expect(await repo().deleteChannel("501")).toBe(false);
  });
});
