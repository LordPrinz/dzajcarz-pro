// The messages of the open channel and how pages and live events change them. Pure, so it is tested without a
// browser.
import {
  emptyResolved,
  type MessagePage,
  mergeResolved,
  type PanelMessage,
  type Resolved,
} from "./reading-api.ts";

export interface Timeline {
  source: "archive" | "live";
  /** Oldest first, no id twice. */
  messages: PanelMessage[];
  resolved: Resolved;
  hasOlder: boolean;
  /** The view does not reach the latest message (opened around a search result): live messages wait. */
  hasNewer: boolean;
}

export const timelineOf = (page: MessagePage): Timeline => ({
  source: page.source,
  messages: page.messages,
  resolved: page.resolved ?? emptyResolved(),
  hasOlder: page.hasOlder,
  hasNewer: page.hasNewer,
});

const byTime = (a: PanelMessage, b: PanelMessage) =>
  a.createdAt === b.createdAt
    ? a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : a.createdAt < b.createdAt
      ? -1
      : 1;

/** Adds messages, the newer copy of a message winning, and keeps the order. */
function merge(current: PanelMessage[], added: PanelMessage[]): PanelMessage[] {
  // The common case, a live message newer than everything shown: append, no sort.
  const [only] = added;
  const last = current.at(-1);
  if (added.length === 1 && only && (!last || byTime(last, only) < 0)) return [...current, only];
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of added) byId.set(message.id, message);
  return [...byId.values()].sort(byTime);
}

/** An older page joins at the top. */
export const withOlder = (timeline: Timeline, page: MessagePage): Timeline => ({
  ...timeline,
  messages: merge(timeline.messages, page.messages),
  resolved: mergeResolved(timeline.resolved, page.resolved),
  hasOlder: page.hasOlder,
});

/** A newer page joins at the bottom. */
export const withNewer = (timeline: Timeline, page: MessagePage): Timeline => ({
  ...timeline,
  messages: merge(timeline.messages, page.messages),
  resolved: mergeResolved(timeline.resolved, page.resolved),
  hasNewer: page.hasNewer,
});

/**
 * The latest page after a reconnect. When it reaches back to what is shown, the two join; when there is a gap
 * (more was sent than one page while the socket was down), the latest page replaces the view.
 */
export function withLatest(timeline: Timeline, page: MessagePage): Timeline {
  const first = page.messages[0];
  const last = timeline.messages.at(-1);
  const gap = page.hasOlder && first !== undefined && last !== undefined && byTime(last, first) < 0;
  if (gap) return timelineOf(page);
  return {
    ...timeline,
    messages: merge(timeline.messages, page.messages),
    resolved: mergeResolved(timeline.resolved, page.resolved),
  };
}

export type LiveEvent =
  | {
      event: "message.created" | "message.updated";
      payload: { message: PanelMessage; resolved: Resolved };
    }
  | {
      event: "message.deleted";
      payload: { guildId: string | null; channelId: string; ids: string[] };
    };

/** Whether a socket message is a live message event (the server sends nothing else on a channel topic). */
export function parseLiveEvent(data: unknown): LiveEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const { event, payload } = data as { event?: unknown; payload?: unknown };
  if (typeof payload !== "object" || payload === null) return null;
  if (event === "message.created" || event === "message.updated") {
    const { message, resolved } = payload as { message?: PanelMessage; resolved?: Resolved };
    if (typeof message?.id !== "string" || typeof message.channelId !== "string" || !resolved) {
      return null;
    }
    return { event, payload: { message, resolved } };
  }
  if (event === "message.deleted") {
    const deleted = payload as { channelId?: unknown; ids?: unknown; guildId?: unknown };
    if (typeof deleted.channelId !== "string" || !Array.isArray(deleted.ids)) return null;
    return {
      event,
      payload: {
        guildId: typeof deleted.guildId === "string" ? deleted.guildId : null,
        channelId: deleted.channelId,
        ids: deleted.ids.filter((id): id is string => typeof id === "string"),
      },
    };
  }
  return null;
}

export const eventChannel = (event: LiveEvent): string =>
  event.event === "message.deleted" ? event.payload.channelId : event.payload.message.channelId;

/**
 * A live event applied to the open channel. A new message joins only when the view reaches the latest one;
 * an edit replaces a message on screen; a deletion keeps the message and marks it, as the archive does.
 */
export function applyLiveEvent(timeline: Timeline, event: LiveEvent, now = new Date()): Timeline {
  switch (event.event) {
    case "message.created": {
      if (timeline.hasNewer) return timeline;
      return {
        ...timeline,
        messages: merge(timeline.messages, [event.payload.message]),
        resolved: mergeResolved(timeline.resolved, event.payload.resolved),
      };
    }
    case "message.updated": {
      const known = timeline.messages.some((m) => m.id === event.payload.message.id);
      if (!known) return timeline;
      const previous = timeline.messages.find((m) => m.id === event.payload.message.id);
      return {
        ...timeline,
        messages: merge(timeline.messages, [
          { ...event.payload.message, deletedAt: previous?.deletedAt ?? null },
        ]),
        resolved: mergeResolved(timeline.resolved, event.payload.resolved),
      };
    }
    case "message.deleted": {
      const ids = new Set(event.payload.ids);
      if (!timeline.messages.some((m) => ids.has(m.id))) return timeline;
      const at = now.toISOString();
      return {
        ...timeline,
        messages: timeline.messages.map((m) =>
          ids.has(m.id) && m.deletedAt === null ? { ...m, deletedAt: at } : m,
        ),
      };
    }
  }
}
