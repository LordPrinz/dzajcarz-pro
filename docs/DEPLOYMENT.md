# Deployment

Production runs on one Docker host with [`infra/docker-compose.prod.yml`](../infra/docker-compose.prod.yml).
The bot is a single image: the [`Dockerfile`](../Dockerfile) compiles it with `bun build --compile` into one
binary that migrates the database, connects to Discord and deploys the slash commands. Postgres 18, Redis 8,
Lavalink 4.2.2 and yt-cipher run next to it as separate services. Music is always on in production.

Nothing is published to the network except the health endpoint, which compose always binds to
`127.0.0.1:<HEALTH_PUBLISH_PORT>` (default 8080) on the host, never to a public address. The services find
each other by name, and compose builds `DATABASE_URL`, `REDIS_URL` and `LAVALINK_URL` from the passwords in
`.env`. Postgres and Redis sit on an internal network with no route out; Lavalink and yt-cipher
on one that reaches the internet. The bot is on both and reaches Discord through the second. The Postgres,
Redis and Lavalink images are pinned by digest, and Lavalink and yt-cipher run read-only with every
capability dropped. Redis reads its password from a config file on a tmpfs, so it shows up neither in `ps`
nor in the command `docker inspect` prints.

The deployed version is the commit checked out on the server. Every start builds the image from that
checkout and tags it `dzajcarz-bot:<short commit>`, so `docker ps` shows which commit runs (the image also
carries it in the `org.opencontainers.image.revision` label).

## Commands on the host

The `bun run prod:*` scripts need Bun on the host. Without Bun, define this shell function once (for example
in `~/.bashrc`) and use it instead; it does what the scripts do:

```bash
prod() {
  BOT_REVISION=$(git rev-parse --short HEAD) \
    docker compose --env-file .env -f infra/docker-compose.prod.yml "$@"
}
```

| With Bun            | Without Bun             |
| ------------------- | ----------------------- |
| `bun run prod:up`   | `prod up -d --build`    |
| `bun run prod:down` | `prod down`             |
| `bun run prod:logs` | `prod logs -f bot`      |
| (none)              | `prod ps`, `prod exec`… |

Run them from the repository root. Compose refuses to start without `BOT_REVISION`, so a plain
`docker compose up` cannot run an image that does not match the checkout.

## Before the first deploy

In the [Discord developer portal](https://discord.com/developers/applications), on the application's _Bot_
page, turn on the **Message Content** and **Server Members** intents. Without them prefix commands and
welcome messages stay silent (see the [README](../README.md#getting-started)).

The host needs Docker with the compose plugin, and Bun (or the `prod` function above), git and a checkout
of this repository: the image is built from it, and Lavalink mounts `infra/lavalink/application.yml` and the scheduled songs in
`infra/lavalink/music`.

```bash
git clone git@github.com:LordPrinz/dzajcarz-pro.git dzajcarz && cd dzajcarz   # main is the default branch
cp .env.example .env && chmod 600 .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, the five passwords (openssl rand -hex 32 for each)
# and WEB_PUBLIC_ORIGIN (the public URL of the web panel, see below)
bun run prod:up
```

Production reads the same `.env` as local development, but only the values the bot needs on a server: the
token, the client id, the passwords, `BOT_PREFIX`, `RIOT_VALORANT_API_KEY`, `RIOT_LOL_API_KEY`, `LOG_LEVEL`, the scheduled song
settings and `HEALTH_PUBLISH_PORT`. The web panel adds `WEB_PUBLIC_ORIGIN`, `WEB_POSTGRES_PASSWORD`, `WEB_REDIS_PASSWORD` (all required) and `BOT_REQUEST_TIMEOUT_MS`. Compose passes each one to the container by name, so `DATABASE_URL`,
`REDIS_URL`, `WEB_DATABASE_URL`, `WEB_REDIS_URL`, `LAVALINK_URL`, `DISCORD_DEV_GUILD_ID`, the test bot's `DISCORD_DEV_TOKEN` and `DISCORD_DEV_CLIENT_ID`, and the `TEST_*` URLs in the file never reach the
production container. Without a dev guild the bot deploys its slash commands globally. The production stack
is a separate compose project with its own volumes, so it does not share data with `bun run infra:up`.

The passwords end up inside `DATABASE_URL` and `REDIS_URL`. The bot refuses to start when one of them breaks
the URL (an unencoded `@`, `/`, `?` or `#`), so stick to hex passwords. On the first start
`lavalink-plugins-init` downloads the YouTube plugin, so music can take a minute to come up. It checks the jar
against `infra/lavalink/youtube-plugin.sha256` and stops the stack before Lavalink starts if the hash differs
([ADR 4](adr/0004-lavalink-for-audio.md#youtube-setup-dzaj-50)). Its log says why:

```bash
prod logs lavalink-plugins-init
```

`POSTGRES_PASSWORD` only takes effect when the `postgres-data` volume is first created. To change it later,
change it in the database first, then in `.env`, then run `bun run prod:up`:

```bash
prod exec postgres psql -U dzajcarz -c "ALTER USER dzajcarz PASSWORD '<new hex password>'"
```

## Web panel

The panel ([ADR 9](adr/0009-web-panel-as-a-separate-process.md)) is the `web` service, built from the same
`Dockerfile` (`--target web`). It has **no login of its own**: it must only ever be reachable through a reverse
proxy that has Authentik forward auth in front of it. It publishes no host port. The proxy reaches it over the
`dzajcarz-panel` network, which only `web` and the proxy may join, since anything on that network talks to the
panel without Authentik. The panel does not wait for the bot; it starts alone and says "Bot niedostępny"
until the bot answers.

Set `WEB_PUBLIC_ORIGIN` in `.env` to the public URL, as a bare origin (`https://panel.example.com`, no path,
no trailing slash). Compose refuses to start without it. The panel compares every `Host` and `Origin` with it.

The panel has its own logins and never uses the bot's, so a bug in it cannot touch the bot's data:

- **Postgres:** the role `dzajcarz_web`, which may only read and add `web_audit` rows and set their outcome.
  The bot's migration creates it without a login and grants that; the one-shot `web-db-role` service then
  runs [`infra/postgres/web-role.sql`](../infra/postgres/web-role.sql) as `dzajcarz` on every
  `bun run prod:up` and sets its password from `WEB_POSTGRES_PASSWORD`. This works on an existing volume
  too, and changing the password in `.env` takes effect on the next `prod:up`. The panel never migrates: on
  the very first deploy it restarts until the bot has created `web_audit`.
- **Redis:** the ACL user `web`, limited by [`infra/redis/web-user.acl`](../infra/redis/web-user.acl) to
  publishing and subscribing on `dzajcarz:web:*` and `PING`. The redis service writes it into its config
  on the tmpfs from `WEB_REDIS_PASSWORD`, so it is recreated (with the new password) on every start.

Every response carries a strict `Content-Security-Policy` (scripts, styles and data from the panel itself,
images also from `cdn.discordapp.com`, no framing), `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`. A proxy that adds its own policy must not loosen it.

`dzajcarz-panel` is an internal network: the panel has no route out. In the proxy's own compose project,
attach it to the network and point it at `web:3000`; the proxy keeps reaching the internet through its other
networks:

```yaml
services:
  proxy:
    networks: [panel] # plus whatever it already uses

networks:
  panel:
    name: dzajcarz-panel
    external: true
```

The proxy has to:

- authenticate every request with Authentik forward auth before it reaches the panel;
- **overwrite** the `X-authentik-*` request headers with the ones from the auth response and never pass
  client-sent values through: the panel writes `X-authentik-username` into its audit log;
- forward the original `Host` header (nginx: `proxy_set_header Host $host;`; Caddy and Traefik do it by
  default). The panel answers `421` to any other `Host`, so a proxy that rewrites it breaks every request;
- pass WebSocket upgrades on `/api/ws` (nginx: `Upgrade` and `Connection` headers).

`docker ps` shows the container's health through `web healthcheck`, which asks the panel's own `/health`
(Postgres and Redis; the bot being down does not count). Logs: `prod logs -f web`.

## Release

```bash
git pull            # or: git checkout <tag or commit>
# A release that adds a migration: take a dump first (see Backups), because the bot migrates as it starts.
bun run prod:up     # builds the checked-out commit and recreates what changed
```

Compose recreates only the containers whose image or settings changed; the bot gets `SIGTERM` and 30 seconds
to leave voice channels and close its connections. Then the new bot:

1. applies the pending migrations under a Postgres advisory lock (waiting at most 60 seconds for it), before
   it logs in. A failed migration exits with code 1 and the bot never logs in; the restart policy keeps
   retrying, and the log says why.
2. logs in to Discord.
3. once the gateway is ready, deploys the slash commands globally, because production sets no
   `DISCORD_DEV_GUILD_ID`. It sends them only when Discord's set differs from the code. Discord can take a
   while to show changed global commands.

`bun run commands:deploy` is not needed in production.

### Checking a release

```bash
bun run prod:logs                      # or: prod logs -f bot
curl -s http://127.0.0.1:8080/health   # {"ok":true,"checks":{"gateway":true,"postgres":true,"redis":true}}
docker ps --filter name=dzajcarz-prod-bot   # image dzajcarz-bot:<commit>, status (healthy)
```

The log is one JSON line per event, in this order on a good start: `Applied migrations` (or
`Database is up to date`), `Logged in`, then `Deployed slash commands` or `Slash commands are up to date`.
The Docker health check runs `bot healthcheck` against `/health`, so `docker ps` shows `unhealthy` while the
gateway, Postgres or Redis is down. The [health endpoint](DESIGN.md#health-endpoint) describes the checks.

### Rollback

Check out the previous version and start it the same way:

```bash
git checkout <previous tag or commit>
bun run prod:up     # the old image is still there, so the build is mostly cached
```

Migrations are forward-only, and the old binary ignores tables and columns it does not know. A release whose
migration removed or changed something the old code still uses cannot be rolled back this way: restore the
backup taken before it instead. Go back to the branch with `git checkout main` before the next `git pull`.

### Old images

Every release leaves its image behind. Remove the bot images no container uses that are older than a month:

```bash
docker image prune -a --filter "label=org.opencontainers.image.title=dzajcarz-bot" --filter "until=720h"
```

### Upgrading Postgres from 17 to 18

The 18 image keeps its data in a versioned subdirectory, so the volume is mounted at `/var/lib/postgresql`
and it refuses a volume that holds a 17 cluster. Dump with a 17 container, then restore into a fresh volume:

```bash
prod stop bot postgres
docker run -d --name pg17 -v dzajcarz-prod_postgres-data:/var/lib/postgresql/data postgres:17-alpine
docker exec pg17 pg_dumpall -U dzajcarz > pg17.sql && docker rm -f pg17
docker volume create dzajcarz-prod_postgres-data-pg17-backup   # then copy the old volume into it
docker volume rm dzajcarz-prod_postgres-data
prod up -d postgres
docker exec -i dzajcarz-prod-postgres-1 psql -U dzajcarz -d postgres < pg17.sql   # "already exists" errors are expected
```

Keep the backup volume and `pg17.sql` until the bot has run cleanly for a day.

## Backups

Postgres holds everything worth keeping (guild settings, party areas, moderation history); Redis holds only
state that may be lost. Take a dump before every release that adds a migration, and on a schedule. These
commands use the `prod` function from [Commands on the host](#commands-on-the-host):

```bash
prod exec -T postgres pg_dump -U dzajcarz -Fc dzajcarz > dzajcarz-$(date +%F).dump
```

Restore into the running database (stop the bot first so nothing writes in between):

```bash
prod stop bot
prod exec -T postgres pg_restore -U dzajcarz -d dzajcarz --clean --if-exists < dzajcarz-2026-01-31.dump
prod start bot
```

The data lives in the `dzajcarz-prod_postgres-data` volume. `prod:down` keeps it; only `down -v` deletes it.

## Logs and disk

Every service uses Docker's `json-file` log driver capped at five 10 MB files, so logs cannot fill the
disk. `LOG_LEVEL=debug` in `.env` and another `bun run prod:up` make the bot more talkative.
