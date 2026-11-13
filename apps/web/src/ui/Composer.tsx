import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { authorName, type ChannelRef, type PanelMessage } from "./reading-api.ts";
import {
  type ChannelInfo,
  checkFiles,
  DEFAULT_UPLOAD_LIMIT,
  type Draft,
  MAX_MESSAGE_LENGTH,
  newNonce,
  sendMessage,
  uploadFile,
  WRITE_ERRORS,
} from "./write-api.ts";

const draftKey = (channelId: string) => `dzajcarz:draft:${channelId}`;

/** The saved text of a channel's draft; storage can be missing or refuse (private mode). */
function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(draftKey(channelId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(channelId: string, content: string): void {
  try {
    if (content) localStorage.setItem(draftKey(channelId), content);
    else localStorage.removeItem(draftKey(channelId));
  } catch {
    // The draft still lives in the page's state.
  }
}

/** Ctrl+Enter, or Cmd+Enter on a Mac, sends. */
export const isSendShortcut = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">) =>
  event.key === "Enter" && (event.ctrlKey || event.metaKey);

interface PendingFile {
  /** Tells two files of the same name apart in the list. */
  key: string;
  file: File;
  /** Set once uploaded; kept for a retry, dropped when the bot says the upload is gone. */
  id?: string;
}

export interface ComposerProps {
  channel: ChannelRef;
  /** What the bot may do here; null while unknown (the bot then decides on send). */
  info: ChannelInfo | null;
  replyTo: PanelMessage | null;
  onCancelReply: () => void;
}

/**
 * Writes as the bot. The draft stays (in state and in localStorage) until the bot confirms the message, so a
 * bot that is down or a refusal never loses it. Mentions are off unless "Pinguj" is ticked for this message.
 */
export function Composer({ channel, info, replyTo, onCancelReply }: ComposerProps) {
  const [content, setContent] = useState(() => loadDraft(channel.id));
  const [allowMentions, setAllowMentions] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One nonce per draft: a retry of the same draft is not posted twice; any change makes it a new one. */
  const nonce = useRef(newNonce());
  const fileInput = useRef<HTMLInputElement>(null);

  const changed = () => {
    nonce.current = newNonce();
  };
  // Replying to another message (or no longer replying) makes another message.
  const replyId = replyTo?.id ?? null;
  const lastReply = useRef(replyId);
  useEffect(() => {
    if (lastReply.current === replyId) return;
    lastReply.current = replyId;
    nonce.current = newNonce();
  }, [replyId]);
  const uploadLimit = info?.uploadLimit ?? DEFAULT_UPLOAD_LIMIT;
  const blocked = info !== null && !info.can.send;
  const empty = content.trim() === "" && files.length === 0;
  /** What the form holds now, for a send that finishes after the user kept typing. */
  const latest = useRef({ content, allowMentions, replyId });
  latest.current = { content, allowMentions, replyId };

  const edit = (value: string) => {
    setContent(value);
    saveDraft(channel.id, value);
    changed();
  };

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next = [...files, ...[...list].map((file) => ({ key: crypto.randomUUID(), file }))];
    const problem = checkFiles(
      next.map(({ file }) => file),
      uploadLimit,
    );
    if (fileInput.current) fileInput.current.value = "";
    if (problem) {
      setError(problem);
      return;
    }
    if (info && !info.can.attach) {
      setError(WRITE_ERRORS.no_attach);
      return;
    }
    setError(null);
    setFiles(next);
    changed();
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, at) => at !== index));
    changed();
  };

  const send = async () => {
    if (sending || empty || blocked) return;
    const problem = checkFiles(
      files.map(({ file }) => file),
      uploadLimit,
    );
    if (problem) {
      setError(problem);
      return;
    }
    // Exactly this goes out; whatever changes while it is in flight stays in the form.
    const sent = { content, allowMentions, nonce: nonce.current, replyId };
    setSending(true);
    setError(null);
    const uploaded = [...files];
    /** Puts the upload ids (or their absence) on the files still listed, which may include newer ones. */
    const markUploads = (marked: PendingFile[]) =>
      setFiles((listed) =>
        listed.map((file) => marked.find(({ key }) => key === file.key) ?? file),
      );
    for (const [index, pending] of uploaded.entries()) {
      if (pending.id) continue;
      const result = await uploadFile(pending.file);
      if (!result.ok) {
        markUploads(uploaded);
        setError(`${pending.file.name}: ${WRITE_ERRORS[result.error]}`);
        setSending(false);
        return;
      }
      uploaded[index] = { ...pending, id: result.data.id };
    }
    markUploads(uploaded);
    const draft: Draft = {
      content: sent.content,
      allowMentions: sent.allowMentions,
      nonce: sent.nonce,
      ...(sent.replyId ? { replyTo: sent.replyId } : {}),
      ...(uploaded.length > 0 ? { attachmentIds: uploaded.flatMap(({ id }) => id ?? []) } : {}),
    };
    const result = await sendMessage(channel.id, draft);
    setSending(false);
    if (!result.ok) {
      // Gone uploads are sent again next time.
      if (result.error === "upload_missing")
        markUploads(uploaded.map(({ key, file }) => ({ key, file })));
      setError(WRITE_ERRORS[result.error]);
      return;
    }
    const now = latest.current;
    if (now.content === sent.content) {
      setContent("");
      saveDraft(channel.id, "");
    }
    if (now.allowMentions === sent.allowMentions) setAllowMentions(false);
    if (now.replyId === sent.replyId) onCancelReply();
    const sentKeys = new Set(uploaded.map(({ key }) => key));
    setFiles((rest) => rest.filter(({ key }) => !sentKeys.has(key)));
    // Anything kept is a new message: it must not reuse the nonce of the one just posted.
    if (nonce.current === sent.nonce) changed();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendShortcut(event)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="composer"
      aria-label="Napisz jako bot"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {blocked ? (
        <p className="notice notice-warn" role="status">
          {WRITE_ERRORS.no_send}
        </p>
      ) : null}
      {replyTo ? (
        <p className="composer-reply">
          <span>
            Odpowiedź do <strong>{authorName(replyTo.author)}</strong>
            {replyTo.content ? `: ${replyTo.content.slice(0, 80)}` : ""}
          </span>
          <button
            type="button"
            className="link-button"
            aria-label="Anuluj odpowiedź"
            onClick={() => {
              onCancelReply();
              changed();
            }}
          >
            ✕
          </button>
        </p>
      ) : null}
      <textarea
        className="composer-text"
        aria-label="Treść wiadomości"
        placeholder={`Napisz w ${channel.guildId ? `#${channel.name}` : channel.name}… (Ctrl+Enter wysyła)`}
        value={content}
        maxLength={MAX_MESSAGE_LENGTH}
        rows={3}
        disabled={blocked}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {files.length > 0 ? (
        <ul className="composer-files" aria-label="Załączniki">
          {files.map(({ key, file }, index) => (
            <li key={key}>
              {file.name}{" "}
              <button
                type="button"
                className="link-button"
                aria-label={`Usuń ${file.name}`}
                onClick={() => removeFile(index)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="notice notice-warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-bar">
        <label className="composer-attach">
          Załącz pliki
          <input
            ref={fileInput}
            type="file"
            multiple
            disabled={blocked || sending}
            onChange={(event) => addFiles(event.target.files)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={allowMentions}
            onChange={(event) => {
              setAllowMentions(event.target.checked);
              changed();
            }}
          />{" "}
          Pinguj
        </label>
        <span className="muted">
          {content.length}/{MAX_MESSAGE_LENGTH}
        </span>
        <button type="submit" disabled={sending || empty || blocked}>
          {sending ? "Wysyłanie…" : "Wyślij"}
        </button>
      </div>
    </form>
  );
}
