export interface Guild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
}

/** What the server list shows: the page renders one of these and nothing else. */
export type GuildsState =
  | { kind: "loading" }
  | { kind: "ready"; guilds: Guild[] }
  | { kind: "unavailable" }
  | { kind: "error" };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `/api/guilds`: 200 is the list, 503 means the bot did not answer (absent or too slow), the rest is an error. */
export async function fetchGuilds(fetcher: Fetch = fetch): Promise<GuildsState> {
  try {
    const response = await fetcher("/api/guilds");
    if (response.status === 503) return { kind: "unavailable" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { guilds?: Guild[] };
    return Array.isArray(body.guilds) ? { kind: "ready", guilds: body.guilds } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** `/api/status`: whether the bot has sent a heartbeat lately. Null when the panel itself cannot be asked. */
export async function fetchBotOnline(fetcher: Fetch = fetch): Promise<boolean | null> {
  try {
    const response = await fetcher("/api/status");
    if (!response.ok) return null;
    const body = (await response.json()) as { bot?: string };
    return body.bot === "online";
  } catch {
    return null;
  }
}
