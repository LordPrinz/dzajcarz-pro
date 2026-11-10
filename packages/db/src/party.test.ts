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
  const area = {
    guildId,
    categoryId: "301",
    joinChannelId: "401",
    nameTemplate: "Kanał {user}",
    commandChannel: false,
  };
  const stored = { ...area, panelMessageId: null };
  const channel = { channelId: "501", guildId, ownerId: "601", joinChannelId: "401" };

  test("an area is found by join channel and by category", async () => {
    await repo().addArea(area);
    expect(await repo().findAreaByJoinChannel("401")).toEqual(stored);
    expect(await repo().findAreaByCategory("301")).toEqual(stored);
    expect(await repo().findAreaByJoinChannel("999")).toBeNull();
    expect(await repo().listAreas(guildId)).toEqual([stored]);
    expect(await repo().listAreas("5555555555555555555")).toEqual([]);
    expect(await repo().listAllAreas()).toEqual([stored]);
  });

  test("an area can be created with a template and updated", async () => {
    await repo().addArea({ ...area, nameTemplate: "🔥 {user}", commandChannel: true });
    expect(await repo().findAreaByJoinChannel("401")).toMatchObject({
      nameTemplate: "🔥 {user}",
      commandChannel: true,
    });
    expect(
      await repo().updateArea("401", { nameTemplate: "{user} chill", commandChannel: false }),
    ).toBe(true);
    expect(await repo().findAreaByJoinChannel("401")).toMatchObject({
      nameTemplate: "{user} chill",
      commandChannel: false,
    });
    expect(
      await repo().updateArea("999", { nameTemplate: "x {user}", commandChannel: false }),
    ).toBe(false);
  });

  test("the panel message is remembered, replaced and forgotten", async () => {
    await repo().addArea(area);
    expect(await repo().setPanelMessage("401", "7001")).toBe(true);
    expect(await repo().findAreaByJoinChannel("401")).toMatchObject({ panelMessageId: "7001" });
    expect(await repo().setPanelMessage("401", "7002")).toBe(true);
    expect(await repo().setPanelMessage("401", null)).toBe(true);
    expect(await repo().findAreaByJoinChannel("401")).toMatchObject({ panelMessageId: null });
    expect(await repo().setPanelMessage("999", "7003")).toBe(false);
  });

  test("a row written without the form columns gets the defaults", async () => {
    await (sql as SQL)`
      INSERT INTO party_area (join_channel_id, guild_id, category_id) VALUES ('401', ${guildId}, '301')
    `;
    expect(await repo().findAreaByJoinChannel("401")).toEqual(stored);
  });

  test("a category holds only one area", async () => {
    await repo().addArea(area);
    await expect(repo().addArea({ ...area, joinChannelId: "402" })).rejects.toThrow();
  });

  test("a channel is found by id and by owner", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    expect(await repo().findChannel("501")).toMatchObject(channel);
    expect(await repo().findChannel("501")).toHaveProperty("createdAt");
    expect(await repo().findChannelByOwner(guildId, "601")).toMatchObject(channel);
    expect(await repo().findChannelByOwner(guildId, "602")).toBeNull();
    expect(await repo().findChannelByOwner("5555555555555555555", "601")).toBeNull();
    expect(await repo().listChannelsOfArea("401")).toMatchObject([channel]);
    expect(await repo().listChannels()).toMatchObject([channel]);
  });

  test("a member owns one channel per guild, but may own one in another guild", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    await expect(repo().addChannel({ ...channel, channelId: "502" })).rejects.toThrow();
    await repo().addArea({ ...area, guildId: "7", categoryId: "311", joinChannelId: "411" });
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

  test("a channel's guild must match its area's guild", async () => {
    await repo().addArea(area);
    await expect(repo().addChannel({ ...channel, guildId: "7" })).rejects.toThrow();
  });

  test("deleting an area removes its channels and leaves other areas alone", async () => {
    await repo().addArea(area);
    await repo().addArea({ ...area, categoryId: "302", joinChannelId: "402" });
    await repo().addChannel(channel);
    await repo().addChannel({ ...channel, channelId: "502", ownerId: "602", joinChannelId: "402" });
    const removed = await repo().deleteArea("401");
    expect(removed).toMatchObject([channel]);
    expect(await repo().findChannel("501")).toBeNull();
    expect(await repo().findChannel("502")).not.toBeNull();
    expect(await repo().deleteArea("401")).toBeNull();
  });

  test("transferOwner hands the channel over unless the candidate owns another one", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    await repo().addChannel({ ...channel, channelId: "502", ownerId: "602" });
    expect(await repo().transferOwner("501", "601", "602")).toBe(false);
    expect((await repo().findChannel("501"))?.ownerId).toBe("601");
    expect(await repo().transferOwner("501", "601", "603")).toBe(true);
    expect((await repo().findChannel("501"))?.ownerId).toBe("603");
    expect(await repo().transferOwner("999", "601", "604")).toBe(false);
  });

  test("transferOwner does nothing when the expected owner is no longer the owner", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    expect(await repo().transferOwner("501", "699", "603")).toBe(false);
    expect((await repo().findChannel("501"))?.ownerId).toBe("601");
  });

  test("deleteChannel reports whether there was a row", async () => {
    await repo().addArea(area);
    await repo().addChannel(channel);
    expect(await repo().deleteChannel("501")).toBe(true);
    expect(await repo().deleteChannel("501")).toBe(false);
  });
});

describe("party repository unique violations", () => {
  const failingWith = (error: unknown) =>
    createPartyRepository((() => Promise.reject(error)) as unknown as SQL);

  test("transferOwner reports false when two handovers race into the one-channel-per-owner index", async () => {
    const violation = Object.assign(new Error("duplicate key"), { errno: "23505" });
    expect(await failingWith(violation).transferOwner("501", "601", "602")).toBe(false);
  });

  test("transferOwner still throws on any other database error", async () => {
    const other = Object.assign(new Error("deadlock"), { errno: "40P01" });
    await expect(failingWith(other).transferOwner("501", "601", "602")).rejects.toThrow("deadlock");
  });
});
