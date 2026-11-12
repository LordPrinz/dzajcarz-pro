import type { Logger } from "@dzajcarz/core";
import type { ArchivedMessageInput, MessageArchiveRepository } from "@dzajcarz/db";
import type { ArchivePolicy } from "./archive-policy.ts";

/** Where a message lives: its server (null for a DM), its channel and, for a thread, the thread's parent. */
export interface ArchivePlace {
  guildId: string | null;
  channelId: string;
  parentId: string | null;
}

/** Keeps the archive in step with the gateway. Never throws: a failure is logged and the event dropped. */
export interface ArchiveRecorder {
  created(place: ArchivePlace, message: ArchivedMessageInput): Promise<void>;
  /**
   * `load` gives the message as it is now, or null when it is gone; it runs only when the place is
   * archived, so an uncached edit elsewhere costs no API call.
   */
  updated(
    place: ArchivePlace,
    messageId: string,
    load: () => Promise<ArchivedMessageInput | null>,
  ): Promise<void>;
  /** One message or a bulk delete; every id in the same channel. */
  deleted(place: ArchivePlace, ids: readonly string[], at: Date): Promise<void>;
}

export interface ArchiveRecorderDeps {
  policy: Pick<ArchivePolicy, "archives">;
  archive: Pick<MessageArchiveRepository, "insertMissing" | "recordEdit" | "markDeleted">;
  logger: Logger;
}

/**
 * A create only fills a missing row, so an edit that overtook it is not rolled back; an edit keeps the
 * previous version; a delete only marks the row. Disabled servers, excluded channels and DMs while the DM
 * switch is off are not touched at all.
 *
 * Events of one message run one after another: a delete that arrives while its create is still looking up
 * the settings or inserting would otherwise update no row and be lost.
 */
export function createArchiveRecorder({
  policy,
  archive,
  logger,
}: ArchiveRecorderDeps): ArchiveRecorder {
  /** The last event still running per message id. */
  const inFlight = new Map<string, Promise<void>>();

  /** Runs `task` (which never rejects) after every running event of `ids`. */
  function inOrder(ids: readonly string[], task: () => Promise<void>): Promise<void> {
    const earlier = ids.flatMap((id) => inFlight.get(id) ?? []);
    const current = Promise.all(earlier).then(task);
    for (const id of ids) inFlight.set(id, current);
    void current.then(() => {
      for (const id of ids) if (inFlight.get(id) === current) inFlight.delete(id);
    });
    return current;
  }

  async function guarded(
    what: string,
    place: ArchivePlace,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      if (!(await policy.archives(place.guildId, [place.channelId, place.parentId]))) return;
      await write();
    } catch (error) {
      logger.error("Could not archive a message event", {
        event: what,
        guildId: place.guildId,
        channelId: place.channelId,
        error,
      });
    }
  }

  return {
    created: (place, message) =>
      inOrder([message.id], () => guarded("create", place, () => archive.insertMissing([message]))),
    updated: (place, messageId, load) =>
      inOrder([messageId], () =>
        guarded("update", place, async () => {
          const message = await load();
          if (message) await archive.recordEdit(message);
        }),
      ),
    deleted: (place, ids, at) =>
      inOrder(ids, () => guarded("delete", place, () => archive.markDeleted(ids, at))),
  };
}
