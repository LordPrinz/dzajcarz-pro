# 9. Web panel as a separate process

- **Status:** accepted
- **Date:** 2026-11-11

## Context

The owner wants a web panel to read channels and DMs live, keep an archive, write as the bot and drive
music (#143). The bot is one Bun process holding the Discord gateway; ADR 2 prefers Bun built-ins, ADR 3
keeps Redis for losable state only, ADR 5 keeps modules free of runtime and transport concerns.

## Decision

- The panel is `apps/web`, its own process and container. It serves a React page bundled by `Bun.serve`
  HTML imports, a JSON API and a WebSocket. No Vite, no Next.js.
- It talks to the bot over Redis pub/sub through `@dzajcarz/web-protocol`. Commands go to
  `dzajcarz:web:command` with a correlation id, a `deadline` and the web instance's reply channel; the bot
  checks that the reply channel matches `dzajcarz:web:reply:<uuid>`, drops commands past their deadline,
  and answers on that channel. The web side waits up to `BOT_REQUEST_TIMEOUT_MS` (3 s, at most 25 s to leave
  room for clock skew under the 30 s deadline limit). When `PUBLISH` reaches no subscriber, Redis is down or
  the panel's own reply channel is not subscribed, it answers `bot_unavailable` at once; a silent bot ends in
  `bot_timeout`. Both are 503 and both read "Bot niedostępny" in the panel; the audit log keeps them apart.
  Live events go to `dzajcarz:web:event`, fire and forget; the bot publishes `bot.status` every 15 s and
  the panel treats it as offline after 45 s without one. Every command and event has a zod schema in the
  shared package, checked on both sides.
- **This amends ADR 3.** ADR 3 says code reaches Redis only through the `KeyValueStore` port. From now on
  `packages/kv` also holds a `PubSub` port (publish, subscribe returning an unsubscribe function) with a
  Redis and an in-memory adapter and a shared contract test. Pub/sub is a transport and stores nothing, so
  "Redis holds only state that can be lost" still holds. Each process uses a separate subscriber
  connection, because a subscribed Redis connection cannot run other commands.
- The bot side is one adapter (`apps/bot/src/web-bridge.ts`) built in the composition root. Modules do not
  know the panel exists.
- The panel reads Postgres directly for data it owns or archives, so reading works while the bot is down.
  It never migrates: only the bot changes the schema. The panel checks at startup that `web_audit` exists
  and exits otherwise, so the restart policy retries until the bot has migrated.
- Least privilege. The panel never uses the bot's credentials:
  - Postgres: its own role `dzajcarz_web`. Migration 0014 creates it without a login (roles are
    cluster-wide, so it tolerates one that exists) and grants `SELECT, INSERT` on `web_audit`, `UPDATE` of
    only `outcome` and `error`, and schema usage. On a managed Postgres where the bot's user lacks
    CREATEROLE, the migration logs a NOTICE and skips the role and its grants; the operator creates the role
    once ([deployment](../DEPLOYMENT.md#managed-postgres-without-createrole)). No password lives in a
    migration: the one-shot compose step `web-db-role` runs `infra/postgres/web-role.sql` as the owner on
    every start and sets `LOGIN PASSWORD` from `WEB_POSTGRES_PASSWORD`, which works on an existing volume
    where initdb scripts never run. Migration 0015 (#145) grants `SELECT` on the archive and its settings
    (`archived_message`, `archived_message_version`, `archive_settings`, `archive_dm_settings`) and nothing
    else: the panel never writes them, settings change through the bot. #146 adds grants for any table it
    adds.
  - Redis: its own ACL user `web`, limited by `infra/redis/web-user.acl` to `PUBLISH`, `SUBSCRIBE`,
    `UNSUBSCRIBE` and `PING` on `dzajcarz:web:*`, with no keys. The redis service writes it into the config
    on its tmpfs from `WEB_REDIS_PASSWORD`, next to `requirepass` for the bot. `SELECT` is not allowed, so
    `WEB_REDIS_URL` uses database 0.
  - The `web` user may publish on every `dzajcarz:web:*` channel, so a compromised panel could also forge
    events and replies, not only commands. This is accepted under the trust model below: the panel already
    holds the owner's full command rights, and events and replies only reach panel instances.
- Trust model:
  - The panel has no login. Authentik forward auth on the reverse proxy authenticates the owner.
  - The container publishes no port. It sits on a dedicated Docker network `dzajcarz-panel` that only the
    panel and the reverse proxy join. Membership of that network is the trust boundary: anything on it can
    reach the panel without Authentik, so nothing else may join it. The network is internal, so the panel
    has no route out. Outside Docker it binds 127.0.0.1.
  - The proxy overwrites `X-authentik-*` request headers (client-sent values never pass through) and
    forwards the original `Host`.
  - Every request, the page and its assets included, must carry a `Host` equal to the host of
    `WEB_PUBLIC_ORIGIN` or a loopback name on `WEB_PORT` (421 otherwise), against DNS rebinding. The
    comparison ignores case, one trailing dot and an explicit default port (`:443` for an https origin,
    `:80` for http).
  - Every state-changing request and every WebSocket upgrade must carry an `Origin` equal to
    `WEB_PUBLIC_ORIGIN`, and request bodies must be JSON; anything else is rejected. The checks are
    applied by wrapping every route handler, and a test fails if a handler is not wrapped.
  - Every response carries `Content-Security-Policy: default-src 'self'; img-src 'self'
    https://cdn.discordapp.com https://media.discordapp.net; media-src https://cdn.discordapp.com
    https://media.discordapp.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
    form-action 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; API, health
    and error answers also carry `Cache-Control: no-store`. The two Discord hosts serve avatars, icons,
    custom emoji, attachments and Discord's proxy copies of embed images (#146); an image or video anywhere
    else is shown as a link, so opening a message never makes the browser contact a host a sender picked. Bun's
    HTML-import routes take no response headers, so the page and its assets are read into memory at
    startup (from the compiled binary, or built with `Bun.build` when run from source) and served by plain
    handlers that go through the guard like every other route.
  - Every input is validated with zod.
  - The audit log, `web_audit`:
    - Every state-changing action first writes a `pending` row with `X-authentik-username` when present
      (control characters stripped, at most 255 characters).
    - If that write fails or takes too long, the action does not run and the answer is
      `503 audit_unavailable` (fail closed).
    - The outcome is written afterwards; if only that write fails it is logged and the row stays `pending`.
    - A trigger stops any role from rewriting a row: it is inserted as `pending`, and one update sets its
      outcome and error. The panel's role cannot delete rows; the table owner (the bot's role) still can,
      and can disable the trigger.
    - The header is used for attribution only, never to authorise.
  - The protocol limits what a forged message can do:
    - a command's `deadline` lies at most 30 s after its `sentAt` and after the bot's clock;
    - its name matches `^[a-z]+(\.[a-z_]+)+$` (at most 64 characters);
    - the bot remembers handled ids until their deadline and drops a replay;
    - both sides drop a raw message over 64 KB before parsing it;
    - guild icons must be `https://cdn.discordapp.com` URLs;
    - a WebSocket message over 4 KB closes the socket.
- Message archive (#145):
  - Commands `guilds.channels` (at most 150 channels, flagged `truncated` past that, so a reply stays under
    64 KB), `archive.guild.set`, `archive.dm.set` and `archive.backfill`. The three changing ones run
    through the audit log like every other state-changing endpoint.
  - The bot owns the settings: it writes them on the panel's command and then refreshes its Redis copy.
    The panel cannot reach Redis keys (see the ACL above), so it could not invalidate a cache it wrote
    behind the bot's back.
  - Handlers receive the command's `deadline`. `archive.backfill` does bounded work per call: at most two
    pages of 100 messages, no new page after 1 s or within 1 s of the deadline, each page stored in one
    statement. The panel calls again to go further back, and the bot runs one backfill per channel at a
    time (a second call gets the running one's answer).
  - Trade-off: a page already running is not cut short (discord.js may wait out a 429 inside it), and the
    deadline is the panel's clock, so with skew or a slow Discord the panel can still answer `bot_timeout`.
    That call has stored what it fetched, and running it again stores nothing twice. Making backfill a
    background job with progress events would remove the limit at the cost of more protocol; not worth it
    for a button pressed by hand.
  - Backfill goes back from the oldest stored message only. Messages sent while the bot was down, after
    archiving began, are not filled in.
  - Attachment URLs point at Discord's CDN and are signed with an expiry; the archive keeps the link and
    metadata, not the file. Once a link has expired the panel shows a broken image; refreshing links through
    the bot is left for later.
- Reading (#146):
  - An archived channel (its server archived and neither it nor its thread parent excluded, or a DM while
    the DM switch is on) is read from Postgres, 50 messages a page, keyed on `(created_at, message_id)`.
    Paging forward and opening a page around a message (a search result) always read the archive. Any other
    channel is read live through `channel.messages` (discord.js with `cache: false`) and stored nowhere.
    The reading endpoints change nothing, so they are not audited. Migration 0016 only adds an index on
    `archived_message (author_id, created_at)` for the author lookups; no new table, so no new grant.
  - Every archive read of a channel (a page in any direction, a jump to a message, the versions of a
    message) checks the archive settings first, with the server taken from the stored messages rather than
    from the request; a channel no longer archived answers `409 not_archived`. A thread's parent still comes
    from the request, since the archive does not store it, so a wrong one can only hide or show a thread of
    an archived server. Search is the exception: it covers everything stored, also channels whose archive
    has been switched off since, because those messages stay in Postgres until someone deletes them.
  - A page asks for the source of the pages already shown (`source=archive|live`), so one view never mixes
    the two when the settings change while it is open.
  - Cost ceiling: migration 0017 (and `infra/postgres/web-role.sql`) sets `statement_timeout = 5s` on
    `dzajcarz_web`, and a query cut off by it answers `503 query_timeout`. A search needs at least one word
    that is not excluded (`-word` alone would match nearly every message), else it is a 400.
  - Replies that hold messages must fit in 64 KB: `channel.messages` cuts a message that is too big on its
    own (embed text first, then embeds, content, attachments; marked `truncated`) and then drops the oldest
    messages of the page (`hasMore` stays true). The same applies to every message event. `dms.list` holds at
    most 50 channels, `names.resolve` at most 50 ids of each kind with names cut to 50 characters; tests
    build the worst case of each.
  - Names for mentions: `names.resolve` answers from the bot's caches only, never calling Discord, so it is
    fast and cannot hit a rate limit. For the archive the panel fills the users the bot does not know from
    the authors' latest stored names, and skips the bot while its heartbeat is missing.
  - An edit of a message discord.js has not cached arrives partial; the bot does not fetch it for the live
    view (the archive already fetches it when it stores it), so such an edit shows after a reload.
  - Live events: the bot publishes every message it sees (`message.created`, `message.updated`,
    `message.deleted`) on `dzajcarz:web:event`, archived or not, and the panel forwards each only to the
    WebSockets subscribed to `channel:<id>`. A socket subscribes with `{"type":"subscribe","channelId":…}`
    (zod, strict, a snowflake id), at most 10 channels per socket; anything else closes it with 1008. The
    other way, the panel telling the bot which channels are watched, would publish less but needs a watch
    list with expiry on the bot and a resync after either side restarts; for a friends' bot the traffic is
    small and a `PUBLISH` that reaches no subscriber costs nothing. Either way the messages travel only
    through Redis inside the trust boundary and are stored nowhere.
  - Slow consumers: Bun closes a socket that has more than 1 MB queued (`backpressureLimit`,
    `closeOnBackpressureLimit`), and the page reconnects. Redis disconnects a subscriber that falls 8 MB
    behind, or 2 MB for a minute (`client-output-buffer-limit pubsub 8mb 2mb 60` in both compose files); the
    panel resubscribes and misses the events in between, which a live view can afford.
  - The DM list is the union of the archived DMs and the DM channels discord.js has cached. Discord gives a
    bot no list of its DMs, so after a restart a conversation outside the archive appears only once a
    message arrives in it.
  - Message text is rendered by our own small Discord-markdown renderer into React elements, never through
    `dangerouslySetInnerHTML`; links only from `https:` URLs, with `rel="noopener noreferrer nofollow"`. It
    scans in linear time (inline code and fences use `indexOf`, not a backtracking regex; a test bounds
    hostile input at 50 ms), and a spoiler keeps its links `inert` until it is opened.
  - After the WebSocket reconnects, an open channel at its latest end fetches the latest page and joins
    it (or replaces the view when more than a page was missed); a view opened around a search result says
    to refresh instead.

## Drivers

1. Behaviour when the bot is down or slow: fast, explicit "unavailable", never a delayed replay.
2. Fit with the existing ports-and-adapters layout and the compiled distroless image.
3. One typed contract shared by both processes.

## Alternatives considered

- **Panel inside the bot process**: no IPC, but a panel bug or load can take the gateway down, the panel
  disappears with the bot, and the bot would need an HTTP surface beyond `/health`.
- **Redis Streams** for commands: survives short disconnects, but a command queued while the bot is down
  would run later, it needs acking and trimming, and gives no "nobody listening" signal.
- **HTTP API on the bot**: simple request/reply, but it adds a second listener to the bot and still needs a
  push channel for live events.
- **Synchronizer CSRF tokens / origin from `Host`**: tokens add state for a single-user panel; deriving the
  origin from `Host` lets a proxy misconfiguration disable the check.
- **Bun's built-in HTML-import routes for `/`**: less code and HMR in development, but they take no response
  headers, so the page would ship without the CSP and outside the Host check.
- **The panel migrating at startup like the bot**: it would need DDL rights on the whole schema, which is
  what least privilege is meant to take away.
- **Setting the role's password from the bot at startup**: needs no extra compose step, but puts the panel's
  database password into the bot's environment.

## Why chosen

Pub/sub is at-most-once and stores nothing, which matches ADR 3, and its subscriber count answers "is the
bot there" without waiting. The deadline keeps a late command from running after the panel gave up. A
separate process isolates failures in both directions. Host and Origin checks against an explicit
configured origin are stateless and fail closed.

## Consequences

- Each process holds a second Redis connection for subscriptions; `keepConnected` gains an `onConnect`
  hook so the adapter can resubscribe.
- A command sent during a Redis or bot restart is lost and reported as unavailable; the user retries.
- If more than one bot instance ever subscribes, both would handle a command; write commands added later
  must be safe under that or the bridge must elect one handler.
- Deployment needs the proxy on `dzajcarz-panel`, forwarding `Host` and overwriting `X-authentik-*`
  ([deployment](../DEPLOYMENT.md)). A proxy that rewrites `Host` gets 421 on every request.
- Two more secrets in `.env`, `WEB_POSTGRES_PASSWORD` and `WEB_REDIS_PASSWORD`. Every panel feature that
  reads a new table needs a grant in its migration.
- `bun run web:dev` loses Bun's hot module reload for the page: `--hot` reloads the process instead.
- A reply larger than 64 KB is dropped, so a command whose answer could grow (a long list) must page.
- Every message the bot sees passes through Redis as an event, also while no panel is open. Nothing keeps
  it, but anyone who can subscribe on the `web` or the bot's Redis user can read the server's messages live.

## Follow-ups

- Refreshing expired attachment links through the bot (Discord's `attachments/refresh-urls`).
- #147 send-as-bot commands and the mentions adapter ([ADR 10](0010-mentions-from-the-web-panel.md)).
- #148 music commands and events.
- Consider extracting the health probe runner shared by both apps if a third process appears.
