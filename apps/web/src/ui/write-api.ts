// The panel's writing endpoints (#147). Like reading-api.ts, the shapes mirror `@dzajcarz/web-protocol`
// without bundling zod.

/** Discord's limit for the text of one message. */
export const MAX_MESSAGE_LENGTH = 2000;
/** Discord takes at most 10 files per message. */
export const MAX_FILES = 10;
/** The panel's ceiling for the files of one message, each and all together (MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Discord's upload limit outside a boosted server, assumed while the channel's is unknown. */
export const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;

export interface ChannelInfo {
  guildId: string | null;
  botUserId: string;
  uploadLimit: number;
  can: { send: boolean; attach: boolean; history: boolean; react: boolean; manage: boolean };
}

export interface MemberResult {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Why an action did not happen; each has a Polish text in `WRITE_ERRORS`. */
export type WriteError =
  | "unavailable"
  | "audit_unavailable"
  | "database"
  | "too_large"
  | "uploads_busy"
  | "uploads_full"
  | "invalid"
  | "error"
  | "unknown_channel"
  | "unknown_message"
  | "unknown_user"
  | "unknown_emoji"
  | "no_send"
  | "no_attach"
  | "no_history"
  | "no_react"
  | "dm_not_own"
  | "no_manage"
  | "forbidden"
  | "not_own"
  | "dm_closed"
  | "file_too_large"
  | "too_many_files"
  | "upload_missing";

export const WRITE_ERRORS: Record<WriteError, string> = {
  unavailable: "Bot niedostępny, nic nie wysłano",
  audit_unavailable: "Dziennik zmian niedostępny, nic nie zrobiono",
  database: "Baza danych niedostępna, plik nie został przyjęty",
  too_large: "Plik jest za duży",
  uploads_busy: "Panel przyjmuje teraz inne pliki, spróbuj za chwilę",
  uploads_full: "Za dużo plików czeka na wysłanie, spróbuj za godzinę",
  invalid: "Panel odrzucił to żądanie",
  error: "Coś poszło nie tak, spróbuj jeszcze raz",
  unknown_channel: "Bot nie widzi tego kanału",
  unknown_message: "Tej wiadomości już nie ma",
  unknown_user: "Nie ma takiego użytkownika",
  unknown_emoji: "Bot nie może użyć tego emoji",
  no_send: "Bot nie ma uprawnienia do pisania na tym kanale",
  no_attach: "Bot nie ma uprawnienia do załączania plików na tym kanale",
  no_history: "Bot nie ma uprawnienia do czytania historii, a odpowiedzi i reakcje go wymagają",
  no_react: "Bot nie ma uprawnienia do dodawania reakcji na tym kanale",
  dm_not_own: "W DM bot usuwa tylko swoje wiadomości",
  no_manage:
    "Bot nie ma uprawnienia „Zarządzanie wiadomościami”, więc nie usunie cudzej wiadomości",
  forbidden: "Discord odmówił: bot nie ma tu potrzebnego uprawnienia",
  not_own: "Edytować można tylko wiadomości bota",
  dm_closed: "Ta osoba nie przyjmuje wiadomości prywatnych od bota",
  file_too_large: "Pliki przekraczają limit tego kanału",
  too_many_files: `Najwyżej ${MAX_FILES} plików w jednej wiadomości`,
  upload_missing: "Załączniki wygasły, wyślij jeszcze raz",
};

export type WriteResult<T> = { ok: true; data: T } | { ok: false; error: WriteError };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const REJECTIONS = new Set<string>(Object.keys(WRITE_ERRORS));

/** The panel's error answer as one of the `WriteError` codes. */
async function errorOf(response: Response): Promise<WriteError> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
  if (response.status === 422 && typeof body.reason === "string" && REJECTIONS.has(body.reason)) {
    return body.reason as WriteError;
  }
  switch (body.error) {
    case "bot_unavailable":
    case "bot_timeout":
      return "unavailable";
    case "audit_unavailable":
      return "audit_unavailable";
    case "database_unavailable":
      return "database";
    case "payload_too_large":
      return "too_large";
    case "uploads_busy":
      return "uploads_busy";
    case "uploads_full":
      return "uploads_full";
    case "unknown_channel":
      return "unknown_channel";
    default:
      return response.status === 400 ? "invalid" : "error";
  }
}

async function request<T>(
  fetcher: Fetch,
  path: string,
  init: RequestInit = {},
): Promise<WriteResult<T>> {
  try {
    const response = await fetcher(path, init);
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    return { ok: false, error: await errorOf(response) };
  } catch {
    return { ok: false, error: "error" };
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const messagePath = (channelId: string, messageId?: string) =>
  `/api/channels/${encodeURIComponent(channelId)}/messages${
    messageId ? `/${encodeURIComponent(messageId)}` : ""
  }`;

export const fetchChannelInfo = (channelId: string, fetcher: Fetch = fetch) =>
  request<ChannelInfo>(fetcher, `/api/channels/${encodeURIComponent(channelId)}/info`);

/** One file, sent raw; the answer is the id `sendMessage` takes. */
export const uploadFile = (file: File, fetcher: Fetch = fetch) =>
  request<{ id: string }>(fetcher, `/api/uploads?${new URLSearchParams({ name: file.name })}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });

export interface Draft {
  content: string;
  replyTo?: string;
  allowMentions: boolean;
  attachmentIds?: string[];
  nonce: string;
}

export const sendMessage = (channelId: string, draft: Draft, fetcher: Fetch = fetch) =>
  request<{ status: "ok"; messageId: string }>(
    fetcher,
    messagePath(channelId),
    json("POST", draft),
  );

export const editMessage = (
  channelId: string,
  messageId: string,
  body: { content: string; allowMentions: boolean },
  fetcher: Fetch = fetch,
) => request<{ status: "ok" }>(fetcher, messagePath(channelId, messageId), json("PATCH", body));

export const deleteMessage = (channelId: string, messageId: string, fetcher: Fetch = fetch) =>
  request<{ status: "ok" }>(fetcher, messagePath(channelId, messageId), json("DELETE"));

export const react = (
  channelId: string,
  messageId: string,
  emoji: string,
  remove: boolean,
  fetcher: Fetch = fetch,
) =>
  request<{ status: "ok" }>(
    fetcher,
    `${messagePath(channelId, messageId)}/reactions`,
    json(remove ? "DELETE" : "PUT", { emoji }),
  );

/** The shortest name the member search takes. */
export const MIN_MEMBER_QUERY_LENGTH = 2;

export const searchMembers = (query: string, guildId: string | null, fetcher: Fetch = fetch) => {
  const params = new URLSearchParams({ q: query });
  if (guildId) params.set("guild", guildId);
  return request<{ members: MemberResult[] }>(fetcher, `/api/members?${params}`);
};

export const openDm = (userId: string, fetcher: Fetch = fetch) =>
  request<{ status: "ok"; channelId: string; recipient: MemberResult }>(
    fetcher,
    "/api/dms/open",
    json("POST", { userId }),
  );

/** Wait before a member search starts while typing: one Discord call per server per search. */
export const SEARCH_DEBOUNCE_MS = 300;

/** `run` once calls stop for `ms`, with the last arguments; `cancel` drops a pending call. */
export function debounce<A extends unknown[]>(run: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call(...args: A) {
      clearTimeout(timer);
      timer = setTimeout(() => run(...args), ms);
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}

/** A fresh Discord nonce: at most 25 letters and digits. */
export const newNonce = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 25);

/**
 * A custom emoji as the API takes it: `name:id`, also from Discord's `<:name:id>` / `<a:name:id>` form.
 * Anything else is returned trimmed, for the server to accept or refuse.
 */
export function normalizeEmoji(input: string): string {
  const text = input.trim();
  const custom = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/.exec(text);
  if (!custom) return text;
  return `${custom[1] ? "a:" : ""}${custom[2]}:${custom[3]}`;
}

/** The files a draft may send here, or why not. */
export function checkFiles(
  files: readonly { name: string; size: number }[],
  uploadLimit: number,
): string | null {
  if (files.length > MAX_FILES) return WRITE_ERRORS.too_many_files;
  const tooBig = files.find((file) => file.size > uploadLimit);
  if (tooBig) return `${tooBig.name}: ${WRITE_ERRORS.file_too_large} (${formatLimit(uploadLimit)})`;
  if (files.some((file) => file.size === 0)) return "Pusty plik nie zostanie wysłany";
  // Like the bot: all files together within the channel's limit, which is at most MAX_UPLOAD_BYTES.
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > Math.min(uploadLimit, MAX_UPLOAD_BYTES)) {
    return `Pliki razem przekraczają ${formatLimit(uploadLimit)} na jedną wiadomość`;
  }
  return null;
}

export const formatLimit = (bytes: number): string => `${Math.floor(bytes / 1024 / 1024)} MB`;
