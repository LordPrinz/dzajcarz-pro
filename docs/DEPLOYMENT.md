# Deployment

Production runs on one Docker host with [`infra/docker-compose.prod.yml`](../infra/docker-compose.prod.yml).
The bot is a single image: the [`Dockerfile`](../Dockerfile) compiles it with `bun build --compile` into one
binary that migrates the database, deploys the slash commands and then connects to Discord. Postgres 17,
Redis 8, Lavalink 4.2.2 and yt-cipher run next to it as separate services. Music is always on in production.

Nothing is published to the network except the health endpoint, bound to `127.0.0.1:8080` on the host.
The services find each other by name, and compose builds `DATABASE_URL`, `REDIS_URL` and `LAVALINK_URL`
from the passwords in `.env.production`.

## Before the first deploy

In the [Discord developer portal](https://discord.com/developers/applications), on the application's _Bot_
page, turn on the **Message Content** and **Server Members** intents. Without them prefix commands and
welcome messages stay silent (see the [README](../README.md#getting-started)).

The host needs Docker with the compose plugin and a checkout of this repository: the image is built from it,
and Lavalink mounts `infra/lavalink/application.yml` and the scheduled songs in `infra/lavalink/music`.

```bash
git clone git@github.com:LordPrinz/dzajcarz-pro.git dzajcarz && cd dzajcarz   # v5 is the default branch
cp .env.production.example .env.production && chmod 600 .env.production
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and the three passwords (openssl rand -hex 32 for each)
bun run prod:up    # or: docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d --build
```

The first start of Lavalink downloads the YouTube plugin, so music can take a minute to come up.

## Release

```bash
git pull
export BOT_TAG=$(git rev-parse --short HEAD)
docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d --build
```

`BOT_TAG` names the image `dzajcarz-bot:<commit>`, so every release keeps its own image to roll back to.
Without it the image is `dzajcarz-bot:latest`. Compose recreates only the containers whose image or settings
changed; the bot gets `SIGTERM` and 30 seconds to leave voice channels and close its connections.

On start, before it logs in, the bot:

1. applies the pending migrations under a Postgres advisory lock. A failed migration exits with code 1 and
   the bot never logs in; the restart policy keeps retrying, and the log says why.
2. deploys the slash commands globally, because production sets no `DISCORD_DEV_GUILD_ID`. It sends them only
   when Discord's set differs from the code. Discord can take a while to show changed global commands.

`bun run commands:deploy` is not needed in production.

### Checking a release

```bash
bun run prod:logs                      # or: docker compose … logs -f bot
curl -s http://127.0.0.1:8080/health   # {"ok":true,"checks":{"gateway":true,"postgres":true,"redis":true}}
docker compose --env-file .env.production -f infra/docker-compose.prod.yml ps   # bot: (healthy)
```

The log is one JSON line per event. A good start shows `Applied migrations` (or `Database is up to date`),
`Logged in`, then `Deployed slash commands` or `Slash commands are up to date`. The Docker health check runs
`bot healthcheck` against `/health`, so `docker compose ps` shows `unhealthy` while the gateway, Postgres or
Redis is down. The [health endpoint](DESIGN.md#health-endpoint) describes the checks.

### Rollback

Start the previous image without building:

```bash
BOT_TAG=<previous commit> docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d --no-build bot
```

Migrations are forward-only, and the old binary ignores tables and columns it does not know. A release whose
migration removed or changed something the old code still uses cannot be rolled back this way: restore the
backup taken before it instead.

## Backups

Postgres holds everything worth keeping (guild settings, party areas, moderation history); Redis holds only
state that may be lost. Take a dump before every release that adds a migration, and on a schedule:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml exec -T postgres \
  pg_dump -U dzajcarz -Fc dzajcarz > dzajcarz-$(date +%F).dump
```

Restore into the running database (stop the bot first so nothing writes in between):

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml stop bot
docker compose --env-file .env.production -f infra/docker-compose.prod.yml exec -T postgres \
  pg_restore -U dzajcarz -d dzajcarz --clean --if-exists < dzajcarz-2026-01-31.dump
docker compose --env-file .env.production -f infra/docker-compose.prod.yml start bot
```

The data lives in the `dzajcarz-prod_postgres-data` volume. `prod:down` keeps it; only `down -v` deletes it.

## Logs and disk

Every service uses Docker's `json-file` log driver capped at five 10 MB files, so logs cannot fill the
disk. `LOG_LEVEL=debug` in `.env.production` and an `up -d` make the bot more talkative.
