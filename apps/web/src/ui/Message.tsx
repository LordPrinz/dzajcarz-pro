import { formatBytes } from "@dzajcarz/core/format";
import { useState } from "react";
import { hexColor, httpsUrl, LINK_PROPS, Markdown } from "./markdown.tsx";
import {
  authorName,
  type EmbedCard,
  type EmbedMedia,
  fetchVersions,
  type MessageVersion,
  type PanelAttachment,
  type PanelMessage,
  type Resolved,
} from "./reading-api.ts";

/** The hosts the CSP lets the page load images and video from (ADR 9). */
const MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** The URL when the page may load it as an image or video: https on one of Discord's media hosts. */
export function mediaUrl(value: string | null): string | null {
  const url = value === null ? null : httpsUrl(value);
  return url !== null && MEDIA_HOSTS.has(new URL(url).hostname) ? url : null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;

export function attachmentKind(attachment: PanelAttachment): "image" | "video" | "file" {
  const type = attachment.contentType ?? "";
  if (type.startsWith("image/") || IMAGE.test(attachment.name)) return "image";
  if (type.startsWith("video/") || VIDEO.test(attachment.name)) return "video";
  return "file";
}

function Attachment({ attachment }: { attachment: PanelAttachment }) {
  const link = attachment.url === null ? null : httpsUrl(attachment.url);
  const media = mediaUrl(attachment.url);
  const kind = attachmentKind(attachment);
  if (media && kind === "image") {
    return (
      <a className="attachment-media" href={media} {...LINK_PROPS}>
        <img
          src={media}
          alt={attachment.name}
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          loading="lazy"
        />
      </a>
    );
  }
  if (media && kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user uploads come without captions
      <video
        className="attachment-media"
        src={media}
        controls
        preload="metadata"
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
      />
    );
  }
  return (
    <p className="attachment-file">
      {link ? (
        <a href={link} {...LINK_PROPS}>
          {attachment.name}
        </a>
      ) : (
        <span>{attachment.name} (brak linku)</span>
      )}{" "}
      <span className="muted">{formatBytes(attachment.size)}</span>
    </p>
  );
}

/** An embed image: shown when it is on a Discord host, otherwise only linked. */
function EmbedImage({
  media,
  label,
  className,
}: {
  media: EmbedMedia;
  label: string;
  className: string;
}) {
  const url = mediaUrl(media.url);
  if (url) {
    return (
      <img
        className={className}
        src={url}
        alt={label}
        width={media.width ?? undefined}
        height={media.height ?? undefined}
        loading="lazy"
      />
    );
  }
  const link = httpsUrl(media.url);
  return link ? (
    <a className="embed-link" href={link} {...LINK_PROPS}>
      {label}
    </a>
  ) : null;
}

function Embed({ embed, resolved }: { embed: EmbedCard; resolved: Resolved }) {
  const titleUrl = embed.url === null ? null : httpsUrl(embed.url);
  const video = embed.video ? mediaUrl(embed.video.url) : null;
  const videoLink = embed.video ? httpsUrl(embed.video.url) : null;
  return (
    <div
      className="embed"
      style={embed.color === null ? undefined : { borderLeftColor: hexColor(embed.color) }}
    >
      <div className="embed-body">
        {embed.providerName ? <p className="embed-provider">{embed.providerName}</p> : null}
        {embed.authorName ? <p className="embed-author">{embed.authorName}</p> : null}
        {embed.title ? (
          <p className="embed-title">
            {titleUrl ? (
              <a href={titleUrl} {...LINK_PROPS}>
                {embed.title}
              </a>
            ) : (
              embed.title
            )}
          </p>
        ) : null}
        {embed.description ? <Markdown text={embed.description} resolved={resolved} /> : null}
        {embed.fields.length > 0 ? (
          <dl className="embed-fields">
            {embed.fields.map((field, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fields have no identity beyond their place
                key={index}
                className={field.inline ? "embed-field inline" : "embed-field"}
              >
                <dt>{field.name}</dt>
                <dd>
                  <Markdown text={field.value} resolved={resolved} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {embed.image ? (
          <EmbedImage media={embed.image} label="Obraz z osadzenia" className="embed-image" />
        ) : null}
        {video ? (
          // biome-ignore lint/a11y/useMediaCaption: embedded clips come without captions
          <video className="embed-image" src={video} controls preload="metadata" />
        ) : videoLink ? (
          <a className="embed-link" href={videoLink} {...LINK_PROPS}>
            Film z osadzenia
          </a>
        ) : null}
        {embed.footer ? <p className="embed-footer">{embed.footer}</p> : null}
      </div>
      {embed.thumbnail ? (
        <EmbedImage media={embed.thumbnail} label="Miniatura" className="embed-thumbnail" />
      ) : null}
    </div>
  );
}

const TIME = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" });
const formatTime = (iso: string) => TIME.format(new Date(iso));

function Body({
  content,
  attachments,
  embeds,
  resolved,
}: Pick<PanelMessage, "content" | "attachments" | "embeds"> & { resolved: Resolved }) {
  return (
    <>
      {content ? <Markdown text={content} resolved={resolved} /> : null}
      {attachments.map((attachment) => (
        <Attachment key={attachment.id} attachment={attachment} />
      ))}
      {embeds.map((embed, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: embeds have no id
        <Embed key={index} embed={embed} resolved={resolved} />
      ))}
    </>
  );
}

type VersionsState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; versions: MessageVersion[] }
  | { kind: "error" };

export interface MessageProps {
  message: PanelMessage;
  resolved: Resolved;
  /** Earlier versions exist only in the archive. */
  archived: boolean;
  highlighted?: boolean;
  loadVersions?: (messageId: string) => Promise<MessageVersion[] | null>;
}

/** One message: author, text, files, embeds, and the marks for an edit or a deletion. */
export function Message({
  message,
  resolved,
  archived,
  highlighted = false,
  loadVersions = fetchVersions,
}: MessageProps) {
  const [versions, setVersions] = useState<VersionsState>({ kind: "closed" });
  const toggleVersions = () => {
    if (versions.kind !== "closed") {
      setVersions({ kind: "closed" });
      return;
    }
    setVersions({ kind: "loading" });
    void loadVersions(message.id).then((found) =>
      setVersions(found ? { kind: "ready", versions: found } : { kind: "error" }),
    );
  };
  const name = authorName(message.author);
  const avatar = mediaUrl(message.author.avatarUrl);
  const classes = ["message"];
  if (message.deletedAt) classes.push("message-deleted");
  if (highlighted) classes.push("message-highlight");
  return (
    <article className={classes.join(" ")} data-message-id={message.id}>
      {avatar ? (
        <img className="avatar" src={avatar} alt="" width={36} height={36} />
      ) : (
        <span className="avatar avatar-fallback" aria-hidden="true">
          {[...name][0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <div className="message-main">
        <header className="message-head">
          <span className="message-author" title={message.author.id}>
            {name}
          </span>
          {message.author.bot ? <span className="tag">BOT</span> : null}
          <time className="muted" dateTime={message.createdAt}>
            {formatTime(message.createdAt)}
          </time>
          {message.editedAt ? (
            archived ? (
              <button
                type="button"
                className="link-button"
                aria-expanded={versions.kind !== "closed"}
                onClick={toggleVersions}
              >
                (edytowano)
              </button>
            ) : (
              <span className="muted">(edytowano)</span>
            )
          ) : null}
          {message.deletedAt ? (
            <span className="tag tag-deleted" title={formatTime(message.deletedAt)}>
              usunięta
            </span>
          ) : null}
        </header>
        {message.replyToId ? <p className="message-reply muted">↪ odpowiedź</p> : null}
        <Body
          content={message.content}
          attachments={message.attachments}
          embeds={message.embeds}
          resolved={resolved}
        />
        {message.truncated ? (
          <p className="muted">Wiadomość skrócona, za długa do przesłania w całości.</p>
        ) : null}
        {versions.kind === "loading" ? <p className="muted">Ładowanie historii…</p> : null}
        {versions.kind === "error" ? (
          <p className="muted" role="alert">
            Nie udało się wczytać historii
          </p>
        ) : null}
        {versions.kind === "ready" ? (
          <ol className="versions" aria-label="Wcześniejsze wersje">
            {versions.versions.length === 0 ? (
              <li className="muted">Brak zapisanych wersji</li>
            ) : (
              versions.versions.map((version) => (
                <li key={`${version.replacedAt}:${version.editedAt}`} className="version">
                  <p className="muted">
                    {version.editedAt ? `edycja z ${formatTime(version.editedAt)}` : "oryginał"},
                    zmieniona {formatTime(version.replacedAt)}
                  </p>
                  <Body
                    content={version.content}
                    attachments={version.attachments}
                    embeds={version.embeds}
                    resolved={resolved}
                  />
                </li>
              ))
            )}
          </ol>
        ) : null}
      </div>
    </article>
  );
}
