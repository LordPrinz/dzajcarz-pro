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
  and answers on that channel. The web side waits up to `BOT_REQUEST_TIMEOUT_MS` (3 s). When `PUBLISH`
  reaches no subscriber or Redis is down, it answers `bot_unavailable` at once; a silent bot ends in
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
    only `outcome` and `error`, and the sequence and schema usage. No password lives in a migration: the
    one-shot compose step `web-db-role` runs `infra/postgres/web-role.sql` as the owner on every start and
    sets `LOGIN PASSWORD` from `WEB_POSTGRES_PASSWORD`, which works on an existing volume where initdb scripts
    never run. #145 and #146 add `SELECT` on the archive tables in their own migrations.
  - Redis: its own ACL user `web`, limited by `infra/redis/web-user.acl` to `PUBLISH`, `SUBSCRIBE`,
    `UNSUBSCRIBE` and `PING` on `dzajcarz:web:*`, with no keys. The redis service writes it into the config
    on its tmpfs from `WEB_REDIS_PASSWORD`, next to `requirepass` for the bot. `SELECT` is not allowed, so
    `WEB_REDIS_URL` uses database 0.
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
    https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
    form-action 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Bun's
    HTML-import routes take no response headers, so the page and its assets are read into memory at
    startup (from the compiled binary, or built with `Bun.build` when run from source) and served by plain
    handlers that go through the guard like every other route.
  - Every input is validated with zod. Every state-changing action first writes a `pending` row to
    `web_audit` with `X-authentik-username` when present (control characters stripped, at most 255
    characters); if that write fails the action does not run and the answer is `503 audit_unavailable`
    (fail closed). The outcome is written afterwards; if only that write fails it is logged and the row stays
    `pending`. The header is used for attribution only, never to authorise.
  - The protocol limits what a forged message can do: a command's `deadline` lies at most 30 s after its
    `sentAt` and after the bot's clock, its name matches `^[a-z]+(\.[a-z_]+)+$` (at most 64 characters), the
    bot remembers handled ids until their deadline and drops a replay, and both sides drop a raw message over
    64 KB before parsing it. Guild icons must be `https://cdn.discordapp.com` URLs. A WebSocket message over
    4 KB closes the socket.

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

## Follow-ups

- #145 archive tables and the archive reader in `apps/web`; its migration grants `dzajcarz_web` `SELECT` on
  them (and #146 on any table it adds).
- #146 live channel/DM events and WebSocket topics per channel, with a zod-validated subscribe message.
  Message streams make slow subscribers matter: set Redis `client-output-buffer-limit pubsub` deliberately
  and drop slow WebSocket clients (Bun backpressure) there.
- #147 send-as-bot commands and the mentions adapter ([ADR 10](0010-mentions-from-the-web-panel.md)).
- #148 music commands and events.
- Consider extracting the health probe runner shared by both apps if a third process appears.
