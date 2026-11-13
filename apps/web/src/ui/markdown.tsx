// A small Discord-markdown renderer. It parses into a tree and renders React elements only: message text
// always ends up as text nodes, never as HTML. Links and images are made only from https URLs.
import { type KeyboardEvent, memo, type ReactNode, useMemo, useState } from "react";
import type { Resolved } from "./reading-api.ts";

export type Inline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "strong" | "em" | "u" | "s" | "spoiler"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; url: string; children: Inline[] }
  | { type: "user" | "role" | "channel"; id: string }
  | { type: "everyone"; text: string }
  | { type: "emoji"; name: string; id: string; animated: boolean }
  | { type: "time"; seconds: number; style: string };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "subtext"; children: Inline[] }
  | { type: "codeblock"; lang: string | null; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] };

/** Nested emphasis deeper than this stays text: a hostile message cannot blow the stack. */
const MAX_DEPTH = 8;

/** The URL when it is an https link, else null. Every link and image in the panel goes through this. */
export function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

interface Context {
  depth: number;
  /** Inside a link's label: no further links. */
  inLink: boolean;
}

type Rule = (text: string, at: number, context: Context) => { nodes: Inline[]; end: number } | null;

/** A sticky regex rule: `build` turns the match into nodes (or null to refuse it). */
function rule(
  pattern: RegExp,
  build: (match: RegExpExecArray, context: Context) => Inline[] | null,
): Rule {
  const sticky = new RegExp(pattern.source, `${pattern.flags.replace("y", "")}y`);
  return (text, at, context) => {
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (!match) return null;
    const nodes = build(match, context);
    return nodes ? { nodes, end: at + match[0].length } : null;
  };
}

const deeper = (context: Context): Context => ({ ...context, depth: context.depth + 1 });

const wrap =
  (type: "strong" | "em" | "u" | "s" | "spoiler") =>
  (match: RegExpExecArray, context: Context): Inline[] | null =>
    context.depth >= MAX_DEPTH
      ? null
      : [{ type, children: parseInline(match[1] ?? "", deeper(context)) }];

const link = (url: string, label: Inline[] | null, raw: string, context: Context): Inline[] => {
  const safe = context.inLink ? null : httpsUrl(url);
  return safe
    ? [{ type: "link", url: safe, children: label ?? [{ type: "text", text: url }] }]
    : [{ type: "text", text: raw }];
};

/** A longer run of backticks is plain text: no closer is searched for it. */
const MAX_TICKS = 32;

/** The length of the run of `char` starting at `at`. */
function runLength(text: string, at: number, char: string): number {
  let end = at;
  while (text[end] === char) end += 1;
  return end - at;
}

/**
 * Inline code: a run of N backticks up to the next run of exactly N. A linear scan with `indexOf` instead of a
 * backtracking regex, which took seconds on a message of backticks. A run with no closer becomes text whole.
 */
const inlineCode: Rule = (text, at) => {
  const ticks = runLength(text, at, "`");
  const run = "`".repeat(ticks);
  if (ticks > MAX_TICKS) return { nodes: [{ type: "text", text: run }], end: at + ticks };
  let from = at + ticks;
  while (from < text.length) {
    const close = text.indexOf(run, from);
    if (close === -1) break;
    const length = runLength(text, close, "`");
    if (length === ticks && close > at + ticks) {
      const body = text.slice(at + ticks, close);
      return {
        nodes: [{ type: "code", text: body.replace(/^ (.*) $/s, "$1") }],
        end: close + ticks,
      };
    }
    from = close + length;
  }
  return { nodes: [{ type: "text", text: run }], end: at + ticks };
};

const BARE_URL = /(?<!\w)https?:\/\/[^\s<]+[^<.,:;"')\]\s]/y;

const count = (text: string, char: string) => text.split(char).length - 1;

/** A bare link keeps a closing ")" only when it closes a "(" inside the link: `Foo_(bar)`, not `(see https://a.example)`. */
const bareUrl: Rule = (text, at, context) => {
  BARE_URL.lastIndex = at;
  const match = BARE_URL.exec(text);
  if (!match) return null;
  let url = match[0];
  if (text[at + url.length] === ")" && count(url, "(") > count(url, ")")) url += ")";
  return { nodes: link(url, null, url, context), end: at + url.length };
};

/** The rules that may start at a character, in order of priority. */
const RULES: Record<string, Rule[]> = {
  "\\": [rule(/\\([^A-Za-z0-9\s])/, (m) => [{ type: "text", text: m[1] ?? "" }])],
  "`": [inlineCode],
  "<": [
    rule(/<(a?):(\w{2,32}):(\d{17,20})>/, (m) => [
      { type: "emoji", animated: m[1] === "a", name: m[2] ?? "", id: m[3] ?? "" },
    ]),
    rule(/<@!?(\d{17,20})>/, (m) => [{ type: "user", id: m[1] ?? "" }]),
    rule(/<@&(\d{17,20})>/, (m) => [{ type: "role", id: m[1] ?? "" }]),
    rule(/<#(\d{17,20})>/, (m) => [{ type: "channel", id: m[1] ?? "" }]),
    rule(/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/, (m) => [
      { type: "time", seconds: Number(m[1]), style: m[2] ?? "f" },
    ]),
    rule(/<(https?:\/\/[^\s>]+)>/, (m, context) => link(m[1] ?? "", null, m[0], context)),
  ],
  "[": [
    rule(
      /\[([^[\]\n]{1,512})\]\(\s*<?([^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?\s*\)/,
      (m, context) =>
        link(
          m[2] ?? "",
          context.inLink ? null : parseInline(m[1] ?? "", { ...deeper(context), inLink: true }),
          m[0],
          context,
        ),
    ),
  ],
  // Only at a word boundary: "xhttps://…" stays text.
  h: [bareUrl],
  "*": [
    rule(/\*\*([\s\S]+?)\*\*(?!\*)/, wrap("strong")),
    rule(/\*(?=\S)([\s\S]*?\S)\*(?!\*)/, wrap("em")),
  ],
  _: [rule(/__([\s\S]+?)__(?!_)/, wrap("u")), rule(/\b_((?:__|\\[\s\S]|[^\\_])+?)_\b/, wrap("em"))],
  "~": [rule(/~~([\s\S]+?)~~/, wrap("s"))],
  "|": [rule(/\|\|([\s\S]+?)\|\|/, wrap("spoiler"))],
  "@": [rule(/@(everyone|here)\b/, (m) => [{ type: "everyone", text: m[0] }])],
};

export function parseInline(
  text: string,
  context: Context = { depth: 0, inLink: false },
): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    let matched = false;
    for (const candidate of RULES[char] ?? []) {
      const result = candidate(text, at, context);
      if (result) {
        flush();
        out.push(...result.nodes);
        at = result.end;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (char === "\n") {
      flush();
      out.push({ type: "br" });
    } else {
      buffer += char;
    }
    at += 1;
  }
  flush();
  return out;
}

const LIST_ITEM = /^\s*([-*]|\d{1,3}\.) (.*)$/;

/** Splits a message into blocks: code blocks, quotes, headings, lists and paragraphs. */
export function parseBlocks(source: string, depth = 0): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    }
    paragraph = [];
  };
  let at = 0;
  /** Once no closing fence lies ahead, none lies ahead of a later opener either. */
  let fencesLeft = true;
  while (at < source.length) {
    if (fencesLeft && source.startsWith("```", at)) {
      const close = source.indexOf("```", at + 3);
      if (close === -1) fencesLeft = false;
      if (close > at + 3) {
        endParagraph();
        let body = source.slice(at + 3, close);
        const lang = /^([\w+#.-]{1,32})\n/.exec(body);
        if (lang) body = body.slice(lang[0].length);
        else if (body.startsWith("\n")) body = body.slice(1);
        blocks.push({ type: "codeblock", lang: lang?.[1] ?? null, text: body.replace(/\n$/, "") });
        at = close + 3;
        if (source[at] === "\n") at += 1;
        continue;
      }
    }
    const lineEnd = source.indexOf("\n", at);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(at, end);
    const next = end + 1;

    if (depth === 0 && line.startsWith(">>> ")) {
      endParagraph();
      blocks.push({ type: "quote", children: parseBlocks(source.slice(at + 4), 1) });
      break;
    }
    if (depth === 0 && (line.startsWith("> ") || line === ">")) {
      endParagraph();
      const quoted: string[] = [];
      let cursor = at;
      while (cursor < source.length) {
        const stop = source.indexOf("\n", cursor);
        const quoteEnd = stop === -1 ? source.length : stop;
        const quoteLine = source.slice(cursor, quoteEnd);
        if (!quoteLine.startsWith("> ") && quoteLine !== ">") break;
        quoted.push(quoteLine.slice(2));
        cursor = quoteEnd + 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(quoted.join("\n"), 1) });
      at = cursor;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({
        type: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        children: parseInline(heading[2] ?? ""),
      });
      at = next;
      continue;
    }
    const subtext = /^-# (.+)$/.exec(line);
    if (subtext) {
      endParagraph();
      blocks.push({ type: "subtext", children: parseInline(subtext[1] ?? "") });
      at = next;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      endParagraph();
      const ordered = item[1] !== "-" && item[1] !== "*";
      const items: Inline[][] = [];
      let cursor = at;
      while (cursor < source.length) {
        const stop = source.indexOf("\n", cursor);
        const itemEnd = stop === -1 ? source.length : stop;
        const found = LIST_ITEM.exec(source.slice(cursor, itemEnd));
        if (!found) break;
        const isOrdered = found[1] !== "-" && found[1] !== "*";
        if (isOrdered !== ordered) break;
        items.push(parseInline(found[2] ?? ""));
        cursor = itemEnd + 1;
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number.parseInt(item[1] ?? "1", 10) : 1,
        items,
      });
      at = cursor;
      continue;
    }
    paragraph.push(line);
    at = next;
  }
  endParagraph();
  return blocks;
}

/** Every link the panel renders opens in a new tab, without opener, referrer or endorsement. */
export const LINK_PROPS = { target: "_blank", rel: "noopener noreferrer nofollow" } as const;

const TIME_FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
  t: { timeStyle: "short" },
  T: { timeStyle: "medium" },
  d: { dateStyle: "short" },
  D: { dateStyle: "long" },
  f: { dateStyle: "long", timeStyle: "short" },
  F: { dateStyle: "full", timeStyle: "short" },
};

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** A Discord timestamp as Polish text; `now` in ms for the relative style. */
export function formatTimestamp(seconds: number, style: string, now = Date.now()): string | null {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  if (style === "R") {
    const diff = seconds - Math.round(now / 1000);
    const [unit, size] =
      RELATIVE_UNITS.find(([, length]) => Math.abs(diff) >= length) ?? (["second", 1] as const);
    return new Intl.RelativeTimeFormat("pl", { numeric: "auto" }).format(
      Math.round(diff / size),
      unit,
    );
  }
  return new Intl.DateTimeFormat("pl-PL", TIME_FORMATS[style] ?? TIME_FORMATS.f).format(date);
}

/**
 * Hidden until clicked or opened with Enter or Space. While hidden its content is `inert`: a link inside cannot
 * be clicked or focused before the reader has seen it.
 */
function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reveal = () => setOpen(true);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      reveal();
    }
  };
  if (open) return <span className="spoiler spoiler-open">{children}</span>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot hold the links a spoiler may contain
    <span
      className="spoiler"
      role="button"
      tabIndex={0}
      aria-label="Spoiler, kliknij, aby pokazać"
      onClick={reveal}
      onKeyDown={onKey}
    >
      <span inert>{children}</span>
    </span>
  );
}

/** A Discord colour (0xRRGGBB) as CSS. */
export const hexColor = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

function renderInline(nodes: Inline[], resolved: Resolved): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index, resolved));
}

function renderNode(node: Inline, key: number, resolved: Resolved): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "br":
      return <br key={key} />;
    case "strong":
      return <strong key={key}>{renderInline(node.children, resolved)}</strong>;
    case "em":
      return <em key={key}>{renderInline(node.children, resolved)}</em>;
    case "u":
      return <u key={key}>{renderInline(node.children, resolved)}</u>;
    case "s":
      return <s key={key}>{renderInline(node.children, resolved)}</s>;
    case "spoiler":
      return <Spoiler key={key}>{renderInline(node.children, resolved)}</Spoiler>;
    case "code":
      return <code key={key}>{node.text}</code>;
    case "link":
      return (
        <a key={key} href={node.url} {...LINK_PROPS}>
          {renderInline(node.children, resolved)}
        </a>
      );
    case "user":
      return (
        <span key={key} className="mention" title={node.id}>
          @{resolved.users[node.id] ?? "nieznany-użytkownik"}
        </span>
      );
    case "role": {
      const role = resolved.roles[node.id];
      return (
        <span
          key={key}
          className="mention"
          title={node.id}
          style={role?.color ? { color: hexColor(role.color) } : undefined}
        >
          @{role?.name ?? "nieznana-rola"}
        </span>
      );
    }
    case "channel":
      return (
        <span key={key} className="mention" title={node.id}>
          #{resolved.channels[node.id] ?? "nieznany-kanał"}
        </span>
      );
    case "everyone":
      return (
        <span key={key} className="mention">
          {node.text}
        </span>
      );
    case "emoji":
      return (
        <img
          key={key}
          className="emoji"
          src={`https://cdn.discordapp.com/emojis/${node.id}.${node.animated ? "gif" : "webp"}?size=48`}
          alt={`:${node.name}:`}
          title={`:${node.name}:`}
          loading="lazy"
        />
      );
    case "time": {
      const text = formatTimestamp(node.seconds, node.style);
      if (text === null) return `<t:${node.seconds}:${node.style}>`;
      return (
        <time
          key={key}
          dateTime={new Date(node.seconds * 1000).toISOString()}
          title={formatTimestamp(node.seconds, "F") ?? undefined}
        >
          {text}
        </time>
      );
    }
  }
}

function renderBlocks(blocks: Block[], resolved: Resolved): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, resolved));
}

function renderBlock(block: Block, key: number, resolved: Resolved): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderInline(block.children, resolved)}
        </p>
      );
    case "heading": {
      const Tag = (["h3", "h4", "h5"] as const)[block.level - 1] ?? "h5";
      return (
        <Tag key={key} className="md-heading">
          {renderInline(block.children, resolved)}
        </Tag>
      );
    }
    case "subtext":
      return (
        <p key={key} className="md-subtext">
          {renderInline(block.children, resolved)}
        </p>
      );
    case "codeblock":
      return (
        <pre key={key} className="md-code" data-lang={block.lang ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderBlocks(block.children, resolved)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their place
        <li key={itemIndex}>{renderInline(item, resolved)}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

/** Message text as React elements; parsed once per text, so scrolling the list does not parse again. */
export const Markdown = memo(function Markdown({
  text,
  resolved,
}: {
  text: string;
  resolved: Resolved;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="md">{renderBlocks(blocks, resolved)}</div>;
});
