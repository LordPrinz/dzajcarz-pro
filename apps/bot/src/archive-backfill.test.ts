import { describe, expect, test } from "bun:test";
import type { ArchivedMessageInput } from "@dzajcarz/db";
import {
  type ChannelHistory,
  createArchiveBackfill,
  type HistoryPage,
} from "./archive-backfill.ts";
import type { ArchivePlace } from "./archive-recorder.ts";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const PLACE: ArchivePlace = { guildId: GUILD, channelId: CHANNEL, parentId: null };

/** Message n gets the snowflake-like id 100000000000000000 + n, so ids order like the messages. */
const idOf = (n: number) => String(100000000000000000n + BigInt(n));

function message(n: number): ArchivedMessageInput {
  return {
    id: idOf(n),
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: "3", username: "ola", displayName: null, avatarUrl: null, bot: false },
    content: `m${n}`,
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date(n * 1000),
    editedAt: null,
  };
}

/** A channel holding messages 1..total, paged newest first like Discord. */
function channel(total: number, failure?: HistoryPage) {
  const requests: (string | undefined)[] = [];
  const history: ChannelHistory = {
    place: async (id) => (id === CHANNEL ? PLACE : null),
    async page(_id, before, limit) {
      requests.push(before);
      if (failure) return failure;
      const upper = before === undefined ? total + 1 : Number(BigInt(before) - 100000000000000000n);
      const messages: ArchivedMessageInput[] = [];
      for (let n = upper - 1; n >= 1 && messages.length < limit; n--) messages.push(message(n));
      return { ok: true, messages };
    },
  };
  return { history, requests };
}

/** An archive in memory, keyed by id, like the table with its primary key. */
function memoryArchive() {
  const stored = new Map<string, ArchivedMessageInput>();
  return {
    stored,
    archive: {
      async insertMissing(messages: readonly ArchivedMessageInput[]) {
        let inserted = 0;
        for (const m of messages) {
          if (stored.has(m.id)) continue;
          stored.set(m.id, m);
          inserted++;
        }
        return inserted;
      },
      async oldestInChannel() {
        const ids = [...stored.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        return ids[0] ?? null;
      },
    },
  };
}

const archived = { archives: async () => true };

describe("archive backfill", () => {
  test("pages back from the newest message when nothing is stored, at most maxPages", async () => {
    const { history, requests } = channel(450);
    const { archive, stored } = memoryArchive();
    const backfill = createArchiveBackfill({ history, policy: archived, archive, maxPages: 3 });
    expect(await backfill({ channelId: CHANNEL })).toEqual({
      status: "ok",
      fetched: 300,
      stored: 300,
      oldestId: idOf(151),
      done: false,
    });
    expect(requests).toEqual([undefined, idOf(351), idOf(251)]);
    expect(stored.size).toBe(300);
  });

  test("continues from the oldest stored message and says when it reached the start", async () => {
    const { history, requests } = channel(450);
    const { archive, stored } = memoryArchive();
    const backfill = createArchiveBackfill({ history, policy: archived, archive, maxPages: 3 });
    await backfill({ channelId: CHANNEL });
    expect(await backfill({ channelId: CHANNEL })).toEqual({
      status: "ok",
      fetched: 150,
      stored: 150,
      oldestId: idOf(1),
      done: true,
    });
    expect(requests.slice(3)).toEqual([idOf(151), idOf(51)]);
    expect(stored.size).toBe(450);
  });

  test("running it again over the same range stores nothing twice", async () => {
    const { history } = channel(150);
    const { archive, stored } = memoryArchive();
    const backfill = createArchiveBackfill({ history, policy: archived, archive });
    await backfill({ channelId: CHANNEL });
    expect(await backfill({ channelId: CHANNEL, before: idOf(151) })).toMatchObject({
      status: "ok",
      fetched: 150,
      stored: 0,
    });
    expect(stored.size).toBe(150);
  });

  test("an empty channel is done at once with no oldest message", async () => {
    const { history } = channel(0);
    const backfill = createArchiveBackfill({
      history,
      policy: archived,
      archive: memoryArchive().archive,
    });
    expect(await backfill({ channelId: CHANNEL })).toEqual({
      status: "ok",
      fetched: 0,
      stored: 0,
      oldestId: null,
      done: true,
    });
  });

  test("starts no new page once its time budget is spent", async () => {
    const { history, requests } = channel(1000);
    let clock = 0;
    const timedHistory: ChannelHistory = {
      ...history,
      async page(...args) {
        clock += 1_000;
        return history.page(...args);
      },
    };
    const backfill = createArchiveBackfill({
      history: timedHistory,
      policy: archived,
      archive: memoryArchive().archive,
      maxPages: 5,
      budgetMs: 1_500,
      now: () => clock,
    });
    expect(await backfill({ channelId: CHANNEL })).toMatchObject({ fetched: 200, done: false });
    expect(requests).toHaveLength(2);
  });

  test("starts no page within a second of the panel's deadline", async () => {
    const { history, requests } = channel(1000);
    const backfill = createArchiveBackfill({
      history,
      policy: archived,
      archive: memoryArchive().archive,
      maxPages: 5,
      budgetMs: 60_000,
      now: () => 10_000,
    });
    // The first page always runs; after it, the deadline 900 ms away stops the next one.
    expect(await backfill({ channelId: CHANNEL }, { deadline: 10_900 })).toMatchObject({
      fetched: 100,
      done: false,
    });
    expect(requests).toHaveLength(1);
  });

  test("a second call while one runs for the channel gets the running one's answer", async () => {
    const { history, requests } = channel(150);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ChannelHistory = {
      ...history,
      async page(...args) {
        await gate;
        return history.page(...args);
      },
    };
    const backfill = createArchiveBackfill({
      history: slow,
      policy: archived,
      archive: memoryArchive().archive,
    });
    const first = backfill({ channelId: CHANNEL });
    const second = backfill({ channelId: CHANNEL });
    expect(second).toBe(first);
    release();
    expect(await second).toMatchObject({ status: "ok", fetched: 150 });
    expect(requests).toHaveLength(2);
    // Once it finished, a new call runs again.
    expect(await backfill({ channelId: CHANNEL })).toMatchObject({ fetched: 0, done: true });
  });

  test("refuses a channel that is not archived, without asking Discord", async () => {
    const { history, requests } = channel(10);
    const backfill = createArchiveBackfill({
      history,
      policy: { archives: async () => false },
      archive: memoryArchive().archive,
    });
    expect(await backfill({ channelId: CHANNEL })).toEqual({ status: "not_archived" });
    expect(requests).toEqual([]);
  });

  test("an unknown channel and missing access are answered as such", async () => {
    const unknown = createArchiveBackfill({
      history: channel(10).history,
      policy: archived,
      archive: memoryArchive().archive,
    });
    expect(await unknown({ channelId: "200000000000000099" })).toEqual({
      status: "unknown_channel",
    });
    const denied = createArchiveBackfill({
      history: channel(10, { ok: false, reason: "no_access" }).history,
      policy: archived,
      archive: memoryArchive().archive,
    });
    expect(await denied({ channelId: CHANNEL })).toEqual({ status: "no_access" });
  });
});
