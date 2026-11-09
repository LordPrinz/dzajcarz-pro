# Deployment

Production runs on one Docker host with [`infra/docker-compose.prod.yml`](../infra/docker-compose.prod.yml).
The bot is a single image: the [`Dockerfile`](../Dockerfile) compiles it with `bun build --compile` into one
binary that migrates the database, connects to Discord and deploys the slash commands. Postgres 17, Redis 8,
Lavalink 4.2.2 and yt-cipher run next to it as separate services. Music is always on in production.

Nothing is published to the network except the health endpoint, bound to `127.0.0.1:8080` on the host.
The services find each other by name, and compose builds `DATABASE_URL`, `REDIS_URL` and `LAVALINK_URL`
from the passwords in `.env.production`.

The deployed version is the commit checked out on the server. Every start builds the image from that
checkout and tags it `dzajcarz-bot:<short commit>`, so `docker ps` shows which commit runs (the image also
carries it in the `org.opencontainers.image.revision` label).

## Commands on the host

The `bun run prod:*` scripts need Bun on the host. Without Bun, define this shell function once (for example
in `~/.bashrc`) and use it instead; it does what the scripts do:

```bash
prod() {
  BOT_REVISION=$(git rev-parse --short HEAD) \
    docker compose --env-file .env.production -f infra/docker-compose.prod.yml "$@"
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

The host needs Docker with the compose plugin, git and a checkout of this repository: the image is built
from it, and Lavalink mounts `infra/lavalink/application.yml` and the scheduled songs in
`infra/lavalink/music`.

```bash
git clone git@github.com:LordPrinz/dzajcarz-pro.git dzajcarz && cd dzajcarz   # v5 is the default branch
cp .env.production.example .env.production && chmod 600 .env.production
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and the three passwords (openssl rand -hex 32 for each)
bun run prod:up
```

The passwords end up inside `DATABASE_URL` and `REDIS_URL`. The bot refuses to start when one of them breaks
the URL (an unencoded `@`, `/`, `?` or `#`), so stick to hex passwords. The first start of Lavalink downloads
the YouTube plugin, so music can take a minute to come up.

## Release

```bash
git pull            # or: git checkout <tag or commit>
bun run prod:up     # builds the checked-out commit and recreates what changed
```

Compose recreates only the containers whose image or settings changed; the bot gets `SIGTERM` and 30 seconds
to leave voice channels and close its connections. Then the new bot:

1. applies the pending migrations under a Postgres advisory lock, before it logs in. A failed migration exits
   with code 1 and the bot never logs in; the restart policy keeps retrying, and the log says why.
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
backup taken before it instead. Go back to the branch with `git checkout v5` before the next `git pull`.

### Old images

Every release leaves its image behind. Remove the bot images no container uses that are older than a month:

```bash
docker image prune -a --filter "label=org.opencontainers.image.title=dzajcarz-bot" --filter "until=720h"
```

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
disk. `LOG_LEVEL=debug` in `.env.production` and another `bun run prod:up` make the bot more talkative.
