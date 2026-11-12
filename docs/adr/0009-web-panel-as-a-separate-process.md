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
    adds. Migration 0018 (#147) grants `INSERT` on four columns of `web_upload` (files for messages) and
    nothing else on it: the panel cannot read, change or delete a staged file, nor set its age.
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
    `WEB_PUBLIC_ORIGIN`, and request bodies must be JSON; anything else is rejected. The one exception is
    the file upload (#147): a handler marked with `binaryBody` takes `application/octet-stream` and nothing
    else, JSON included. Like JSON, that type is not one a cross-site form can send, and the Origin and
    Host checks are the same. The checks are applied by wrapping every route handler, and a test fails if a
    handler is not wrapped.
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

- Writing (#147):
  - Commands `channel.info` (what the bot may do in a channel and its upload limit; read-only),
    `message.send`, `message.edit`, `message.delete`, `reaction.add`, `reaction.remove`, `members.search`
    (read-only, at most 25 members) and `dm.open`. The changing ones run through the audit log; the payload
    is the validated request, the text in full (the archive keeps it anyway, and the schema caps it at 2000
    characters), files by id. A refusal is an answer, not an error: `{ status: "rejected", reason }`,
    recorded with the outcome `rejected` and answered 422, so the panel names the missing permission.
  - The bot checks its permissions itself on every command: View Channel and Send Messages (Send Messages
    in Threads in a thread), Attach Files for files, Read Message History for a reply or a reaction, Add
    Reactions for a new reaction, Manage Messages to delete someone else's message. Only the bot's own
    messages can be edited. In a DM it may do everything but delete the other side's messages, which has
    its own reason. Discord's own refusals (a locked thread, a user who takes no DMs, a reply to a message
    deleted meanwhile) map to reasons as well; anything else fails the command.
  - Mentions: one function, `panelMentions` in `apps/bot/src/discord/web-writing.ts`, builds
    `allowedMentions` for sending and editing ([ADR 10](0010-mentions-from-the-web-panel.md)).
  - Files: a pub/sub message holds 64 KB, so files take another way. The page sends each one raw to
    `POST /api/uploads`; the panel stores it in `web_upload` (bytea, at most 25 MiB, the id chosen by the
    panel since its role may not read the row back) and audits the name and size, not the bytes. A name
    with control, invisible or direction-changing characters is refused. The message command carries the
    ids. The bot first reads only their sizes and refuses, before loading any bytes, when one is missing or
    when the files together pass the target's limit (the server's boost tier, 10 MiB in a DM, at most
    25 MiB; one limit for all files is stricter than Discord, which is the safe side). The page checks the
    same limits before uploading (`channel.info` carries the limit).
  - Memory and storage: the panel handles two uploads at a time and answers a third `429 uploads_busy`,
    so at most about 50 MiB of files sit in its memory. Every body is read as a stream with a hard cap,
    64 KB for JSON and 25 MiB for a file, so a chunked body without a length is cut off too; Bun's
    `maxRequestBodySize` (25 MiB plus 64 KB) is only the outer bound. A trigger on `web_upload` refuses an
    insert once the unexpired files would pass 500 MiB (`503 uploads_full`); it runs as its owner, since
    the panel's role may not read the table to add it up, and takes an advisory lock so two inserts cannot
    both pass.
  - Repeats: the bot drops a replayed command id. A message also carries a nonce the page keeps per draft
    (a new one whenever the text, files, reply or mention switch change) and is sent with `enforceNonce`,
    so Discord answers a repeat within a few minutes with the message it already created. Files stay
    staged after a send until the hourly sweep, marked with the nonce that sent them (`sent_nonce`), and
    the bot holds a row lock on them (`SELECT … FOR UPDATE`) while it sends. A retry after `bot_timeout`,
    or two bot instances handling the same command, therefore get the same files with the same nonce and
    post the message once, while another message cannot take files already sent (`upload_missing`).
    Deleting the files after a send would turn such a retry into `upload_missing`, and the owner sending
    again would post twice. Edit, delete and reactions are idempotent on Discord's side.
  - New DMs: `members.search` (at least 2 characters, typed searches start after a 300 ms pause) asks
    Discord (`guild.members.search`) in one server or in every server the bot shares, three at a time and
    no further once 25 members are found, and leaves bots out; `dm.open` opens the DM channel with the
    member picked.

- Music (#148):
  - The panel drives the same `MusicPlayer` instance the music module uses (`apps/bot/src/web-music.ts`,
    wired in the composition root), so the Discord panel and the web panel always show one state. The module
    still knows nothing about the panel: the port gained a `stateChanged` listener event that the Lavalink
    adapter emits after every change no track event reports (pause, loop, volume, filter, seek, queue edits,
    a channel move, also one made by dragging the bot in Discord). The module redraws its panel on it and the
    bridge publishes from it, so a change from either side shows on both. The port also gained
    `moveTrack` and `moveToChannel` ([ADR 4](0004-lavalink-for-audio.md)).
  - The panel acts as the owner. The member rules live in the module and the panel does not go through it:
    no check that the caller sits in the bot's channel, no lock on the scheduled song (DZAJ-123), so the
    panel may pause, seek, loop, skip or disconnect it, and it may move the bot to another channel while
    people listen. No flag at the port level is needed, because the port never enforced the lock.
  - Commands: `music.state` (the player and one page of 20 upcoming tracks from `offset`),
    `music.voice_channels` (at most 50, with listeners and whether the bot may connect and speak),
    `music.join` (joins, or moves the bot), `music.search`, `music.enqueue`, `music.queue.remove`,
    `music.queue.move`, `music.queue.shuffle`, `music.queue.clear` and `music.control` (pause, resume,
    skip, seek, loop, volume 0 to 150, filter, disconnect). Changes answer `ok` or `rejected` with a reason,
    like the writing commands, and run through the audit log as `music.*`. The reads, the search included,
    change nothing and are not audited.
  - A track reaches the panel by a 16-hex-digit hash of the player's own id (a Lavalink encoded track can be
    kilobytes), with its title cut to 150 characters, its author to 80 and its link kept only when it is
    https and at most 512 characters. Remove, move, skip and seek carry the key of the track the panel saw
    and are refused (`queue_changed`, `track_changed`) when another track sits there by now. Tests build
    the worst case of each reply and event.
  - Search results stay on the bot for 10 minutes (at most 50 searches) under a `searchId`; `music.enqueue`
    picks from them (at most 100, a playlist's worth), so the panel never sends a track the bot did not load
    itself. Links follow `/play`'s rules (the module exports its parser). The tracks are the bot's own
    (requester: the bot) but not `byBot`, so they are ordinary members' music to the module. The queue cap
    of 500 applies; the panel's changes run one at a time per guild in their own chain, apart from the
    module's.
  - Without a player, the bot joins the chosen channel and takes that voice channel's chat as the Discord
    panel's channel, as the scheduled song does. So a channel counts as joinable only when the bot may also
    Speak there and Send Messages and Embed Links in its chat. Adding tracks never moves the bot: an
    enqueue naming another channel than the one the bot plays in is refused (`other_channel`); moving is
    `music.join`'s job.
  - A join or a move waits at most 12 s inside the guild's chain, so one that never answers cannot hold
    up the server's other commands. A guild runs at most two searches at once; a third is refused
    (`search_busy`), since each one is a YouTube lookup through the node. Queue places and offsets are
    capped by the queue's 500 tracks (`MAX_MUSIC_QUEUE_LENGTH`, kept equal to the module's cap by a test).
  - Joining, searching and enqueueing wait up to 15 s for the bot instead of `BOT_REQUEST_TIMEOUT_MS`
    (`BotClient.request` takes a per-command timeout, capped at the 30 s deadline limit).
  - Live state: the bot publishes `music.state` per guild after a change, at most one per 500 ms with the
    last change of a burst always sent; the page moves the position on by itself from the moment it received
    the snapshot (its own clock, so a clock that differs from the bot's does not matter), and drops a
    snapshot older than the one it shows (an HTTP reply that loses a race with an event).
    The panel forwards it to sockets on `music:<guildId>`, joined with `{"type":"subscribe","musicGuildId":…}`
    and counted toward the 10 topics per socket. The bot reads `available()` every 2 s and publishes
    `music.status` to every socket when the node comes or goes; the page then disables the controls and
    says Lavalink is down. A bot offline disables them too.
  - Track covers are not shown: YouTube's image hosts would need `img-src` widened, which is not worth it.

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
- If more than one bot instance ever subscribes, both would handle a command. The write commands of #147
  are safe under that (the nonce, idempotent edits, deletes and reactions); a later write command must be
  too, or the bridge must elect one handler.
- Staged files live in Postgres for up to an hour, sent or not, at most 500 MiB at once.
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
- Consider extracting the health probe runner shared by both apps if a third process appears.
