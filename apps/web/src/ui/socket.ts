export interface StatusMessage {
  event: "bot.status";
  online: boolean;
  payload: { guilds: number; startedAt: string } | null;
  lastSeen: number | null;
}

/** `expired`: the proxy no longer lets us through (Authentik session gone), so retrying would only hammer it. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "expired";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** 1 s, 2 s, 4 s … up to 30 s. */
export const backoffDelay = (attempt: number): number =>
  Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

/** Whether `/api/status` still answers as an ordinary API: a 401 or a redirect to the login page does not. */
export async function sessionExpired(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/api/status", { redirect: "manual", cache: "no-store" });
    return response.status === 401 || response.type === "opaqueredirect";
  } catch {
    return false;
  }
}

interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}

/** WebSocket.OPEN, without needing the browser global in tests. */
const OPEN = 1;

export interface SocketOptions {
  url: string;
  onStatus(message: StatusMessage): void;
  onState(state: ConnectionState): void;
  /** Anything else the server sends as JSON: live message events of the watched channel. */
  onEvent?(data: unknown): void;
  createSocket?: (url: string) => SocketLike;
  isExpired?: () => Promise<boolean>;
  schedule?: (callback: () => void, ms: number) => unknown;
}

function parseJson(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function asStatus(value: unknown): StatusMessage | null {
  const status = value as Partial<StatusMessage> | null;
  return status?.event === "bot.status" && typeof status.online === "boolean"
    ? (status as StatusMessage)
    : null;
}

export interface PanelSocket {
  /** Watches one channel's live messages (null: none); kept across reconnects. */
  watch(channelId: string | null): void;
  stop(): void;
}

/** Keeps a WebSocket to the panel open, reconnecting with backoff. */
export function connectSocket({
  url,
  onStatus,
  onState,
  onEvent,
  createSocket = (target) => new WebSocket(target) as unknown as SocketLike,
  isExpired = sessionExpired,
  schedule = setTimeout,
}: SocketOptions): PanelSocket {
  let attempt = 0;
  let stopped = false;
  let current: SocketLike | undefined;
  let watched: string | null = null;

  const sendTo = (socket: SocketLike | undefined, type: string, channelId: string) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify({ type, channelId }));
  };

  function open(): void {
    onState(attempt === 0 ? "connecting" : "reconnecting");
    const socket = createSocket(url);
    current = socket;
    socket.onopen = () => {
      attempt = 0;
      onState("open");
      // A new socket starts with no channel: watch again what was watched.
      if (watched) sendTo(socket, "subscribe", watched);
    };
    socket.onmessage = (event) => {
      const value = parseJson(event.data);
      const status = asStatus(value);
      if (status) onStatus(status);
      else if (value !== null) onEvent?.(value);
    };
    socket.onclose = () => {
      if (stopped || current !== socket) return;
      void retry();
    };
  }

  async function retry(): Promise<void> {
    if (await isExpired()) {
      if (!stopped) onState("expired");
      return;
    }
    if (stopped) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    onState("reconnecting");
    schedule(() => {
      if (!stopped) open();
    }, delay);
  }

  open();
  return {
    watch(channelId) {
      if (channelId === watched) return;
      if (watched) sendTo(current, "unsubscribe", watched);
      watched = channelId;
      if (watched) sendTo(current, "subscribe", watched);
    },
    stop() {
      stopped = true;
      current?.close();
    },
  };
}
