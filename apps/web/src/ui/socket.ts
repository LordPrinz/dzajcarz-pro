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
  close(): void;
}

export interface SocketOptions {
  url: string;
  onStatus(message: StatusMessage): void;
  onState(state: ConnectionState): void;
  createSocket?: (url: string) => SocketLike;
  isExpired?: () => Promise<boolean>;
  schedule?: (callback: () => void, ms: number) => unknown;
}

function parseStatus(data: unknown): StatusMessage | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as Partial<StatusMessage>;
    return value.event === "bot.status" && typeof value.online === "boolean"
      ? (value as StatusMessage)
      : null;
  } catch {
    return null;
  }
}

/** Keeps a WebSocket to the panel open, reconnecting with backoff. Returns a function that stops it. */
export function connectSocket({
  url,
  onStatus,
  onState,
  createSocket = (target) => new WebSocket(target) as unknown as SocketLike,
  isExpired = sessionExpired,
  schedule = setTimeout,
}: SocketOptions): () => void {
  let attempt = 0;
  let stopped = false;
  let current: SocketLike | undefined;

  function open(): void {
    onState(attempt === 0 ? "connecting" : "reconnecting");
    const socket = createSocket(url);
    current = socket;
    socket.onopen = () => {
      attempt = 0;
      onState("open");
    };
    socket.onmessage = (event) => {
      const message = parseStatus(event.data);
      if (message) onStatus(message);
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
  return () => {
    stopped = true;
    current?.close();
  };
}
