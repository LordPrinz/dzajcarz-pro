import { useState } from "react";
import type { PanelMessage } from "./reading-api.ts";
import {
  type ChannelInfo,
  deleteMessage,
  editMessage,
  MAX_MESSAGE_LENGTH,
  normalizeEmoji,
  react,
  WRITE_ERRORS,
  type WriteResult,
} from "./write-api.ts";

/** The emoji offered with one click; anything else goes through the field below them. */
export const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];

type Open = "none" | "react" | "edit" | "delete";

export interface MessageActionsProps {
  message: PanelMessage;
  /** What the bot may do here; null while unknown. */
  info: ChannelInfo | null;
  onReply: (message: PanelMessage) => void;
  /** Shows the outcome of an action above the messages. */
  onNotice: (text: string | null) => void;
}

/**
 * Reply, react, and edit or delete as the bot. Edit is offered only on the bot's own messages; deleting
 * someone else's needs Manage Messages, and without it pressing the button says why. The live events show
 * the result.
 */
export function MessageActions({ message, info, onReply, onNotice }: MessageActionsProps) {
  const [open, setOpen] = useState<Open>("none");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(message.content);
  const [allowMentions, setAllowMentions] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [custom, setCustom] = useState("");

  if (message.deletedAt) return null;
  const own = info !== null && message.author.id === info.botUserId;
  // Saving a cut copy would overwrite the full message on Discord.
  const canEdit = own && !message.truncated;
  /** Why the bot cannot delete this message, or null when it can (or does not know yet). */
  const noDelete =
    own || info === null
      ? null
      : info.guildId === null
        ? "dm_not_own"
        : info.can.manage
          ? null
          : "no_manage";
  const canReact = info === null || info.can.history;

  const run = async (action: () => Promise<WriteResult<unknown>>, done: string) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      onNotice(WRITE_ERRORS[result.error]);
      return false;
    }
    onNotice(done);
    setOpen("none");
    // ADR 10: pinging is asked for each time, also for the next edit.
    setAllowMentions(false);
    return true;
  };

  const toggle = (next: Open) => setOpen(open === next ? "none" : next);

  const sendReaction = (emoji: string) => {
    if (!removing && info !== null && !info.can.react) {
      onNotice(WRITE_ERRORS.no_react);
      return;
    }
    void run(
      () => react(message.channelId, message.id, normalizeEmoji(emoji), removing),
      removing ? "Usunięto reakcję" : "Dodano reakcję",
    ).then((ok) => ok && setCustom(""));
  };

  return (
    <div className="message-actions">
      <div className="message-tools" role="toolbar" aria-label="Akcje wiadomości">
        <button
          type="button"
          onClick={() => (canReact ? onReply(message) : onNotice(WRITE_ERRORS.no_history))}
        >
          Odpowiedz
        </button>
        <button
          type="button"
          aria-expanded={open === "react"}
          onClick={() => (canReact ? toggle("react") : onNotice(WRITE_ERRORS.no_history))}
        >
          Reaguj
        </button>
        {canEdit ? (
          <button
            type="button"
            aria-expanded={open === "edit"}
            onClick={() => {
              setText(message.content);
              setAllowMentions(false);
              toggle("edit");
            }}
          >
            Edytuj
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={open === "delete"}
          // Without the permission the button stays, and pressing it says why nothing can happen.
          onClick={() => (noDelete ? onNotice(WRITE_ERRORS[noDelete]) : toggle("delete"))}
        >
          Usuń
        </button>
      </div>
      {open === "react" ? (
        <div className="emoji-picker">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              disabled={busy}
              aria-label={`${removing ? "Usuń" : "Dodaj"} ${emoji}`}
              onClick={() => sendReaction(emoji)}
            >
              {emoji}
            </button>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (custom.trim()) sendReaction(custom);
            }}
          >
            <input
              aria-label="Inne emoji"
              placeholder="🙂 lub <:nazwa:id>"
              value={custom}
              maxLength={64}
              onChange={(event) => setCustom(event.target.value)}
            />
            <button type="submit" disabled={busy || !custom.trim()}>
              {removing ? "Usuń" : "Dodaj"}
            </button>
          </form>
          <label>
            <input
              type="checkbox"
              checked={removing}
              onChange={(event) => setRemoving(event.target.checked)}
            />{" "}
            usuń reakcję bota
          </label>
        </div>
      ) : null}
      {open === "edit" ? (
        <form
          className="message-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => editMessage(message.channelId, message.id, { content: text, allowMentions }),
              "Zapisano zmiany",
            );
          }}
        >
          <textarea
            aria-label="Nowa treść"
            value={text}
            maxLength={MAX_MESSAGE_LENGTH}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={allowMentions}
              onChange={(event) => setAllowMentions(event.target.checked)}
            />{" "}
            Pinguj
          </label>
          <button type="submit" disabled={busy || text.trim() === ""}>
            Zapisz
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen("none");
              setAllowMentions(false);
            }}
          >
            Anuluj
          </button>
        </form>
      ) : null}
      {open === "delete" ? (
        <p className="message-confirm">
          Usunąć tę wiadomość{own ? "" : " innej osoby"}?{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => deleteMessage(message.channelId, message.id), "Usunięto wiadomość")
            }
          >
            Tak, usuń
          </button>{" "}
          <button type="button" onClick={() => setOpen("none")}>
            Nie
          </button>
        </p>
      ) : null}
    </div>
  );
}
