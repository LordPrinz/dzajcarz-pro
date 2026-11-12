import type { ArchivedMessageInput, MessageArchiveRepository } from "@dzajcarz/db";
import type { BackfillResult, CommandContext } from "@dzajcarz/web-protocol";
import type { ArchivePolicy } from "./archive-policy.ts";
import type { ArchivePlace } from "./archive-recorder.ts";

/** Discord's largest page of channel history. */
export const HISTORY_PAGE_SIZE = 100;
/** No page starts closer than this to the panel's deadline: about one page with its insert. */
const PAGE_RESERVE_MS = 1_000;

export type HistoryPage =
  | { ok: true; messages: ArchivedMessageInput[] }
  | { ok: false; reason: "unknown_channel" | "no_access" };

/** A channel's history on Discord (the adapter waits out rate limits itself). */
export interface ChannelHistory {
  /** Where the channel lives, or null when the bot cannot see it or it holds no messages. */
  place(channelId: string): Promise<ArchivePlace | null>;
  /** Up to `limit` messages older than `before` (the newest when undefined), in any order. */
  page(channelId: string, before: string | undefined, limit: number): Promise<HistoryPage>;
}

export interface ArchiveBackfillDeps {
  history: ChannelHistory;
  policy: Pick<ArchivePolicy, "archives">;
  archive: Pick<MessageArchiveRepository, "insertMissing" | "oldestInChannel">;
  /** Pages per call at most. */
  maxPages?: number;
  /**
   * No new page starts after this long, nor within `PAGE_RESERVE_MS` of the command's deadline, so the
   * answer usually reaches the panel before it gives up. A page already running is not cut short.
   */
  budgetMs?: number;
  now?: () => number;
}

export type ArchiveBackfill = (
  request: { channelId: string; before?: string },
  context?: Partial<CommandContext>,
) => Promise<BackfillResult>;

const olderOf = (a: string, b: string) => (BigInt(a) < BigInt(b) ? a : b);

/**
 * "Load older" for one channel: pages back from `before`, or from the oldest message already stored, and
 * stores what is missing. One call does a bounded amount of work; the panel calls again from `oldestId`.
 * Running it twice stores nothing twice. A call for a channel whose backfill is still running gets that
 * run's answer instead of starting a second one.
 */
export function createArchiveBackfill({
  history,
  policy,
  archive,
  maxPages = 2,
  budgetMs = 1_000,
  now = Date.now,
}: ArchiveBackfillDeps): ArchiveBackfill {
  const running = new Map<string, Promise<BackfillResult>>();

  const run: ArchiveBackfill = async ({ channelId, before }, { deadline } = {}) => {
    const place = await history.place(channelId);
    if (!place) return { status: "unknown_channel" };
    if (!(await policy.archives(place.guildId, [place.channelId, place.parentId]))) {
      return { status: "not_archived" };
    }
    const stopAt = Math.min(now() + budgetMs, (deadline ?? Infinity) - PAGE_RESERVE_MS);
    let cursor = before ?? (await archive.oldestInChannel(channelId)) ?? undefined;
    let fetched = 0;
    let stored = 0;
    let done = false;
    for (let page = 0; page < maxPages && !done; page++) {
      if (page > 0 && now() >= stopAt) break;
      const result = await history.page(channelId, cursor, HISTORY_PAGE_SIZE);
      if (!result.ok) return { status: result.reason };
      const { messages } = result;
      fetched += messages.length;
      stored += await archive.insertMissing(messages);
      done = messages.length < HISTORY_PAGE_SIZE;
      for (const message of messages) {
        cursor = cursor === undefined ? message.id : olderOf(cursor, message.id);
      }
    }
    return { status: "ok", fetched, stored, oldestId: cursor ?? null, done };
  };

  return (request, context) => {
    const current = running.get(request.channelId);
    if (current) return current;
    const started = run(request, context).finally(() => running.delete(request.channelId));
    running.set(request.channelId, started);
    return started;
  };
}
