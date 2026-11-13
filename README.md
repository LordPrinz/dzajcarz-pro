# Dżajcarz

Discord bot for a group of friends: music from YouTube and other sources (Lavalink), party voice channels
created on demand, moderation, welcome messages and a few running jokes. Every command works both as a
slash command (`/ping`) and with a prefix (`!ping`, the prefix is set per server).

This is v5, a rewrite on Bun. The history of the earlier versions (v3 and v4) sits underneath it on `main`.

- **Architecture & decisions:** [docs/DESIGN.md](docs/DESIGN.md)
- **Workflow & conventions:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Production & releases:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Wiki:** generated from these docs on every merge to `main` ([`wiki.yml`](.github/workflows/wiki.yml)); edit the files in this repository, not the wiki
- **Board:** GitHub Projects → _Dzajcarz_ (private)

## Stack

| Layer             | Tech                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| Runtime / tooling | [Bun](https://bun.com) 1.4: package manager, test runner, `Bun.SQL`, `RedisClient` |
| Discord           | discord.js 14                                                                      |
| Music             | Lavalink 4 with the YouTube source plugin                                          |
| Database          | PostgreSQL 18 via `Bun.SQL`, plain SQL migrations                                  |
| Cache / cooldowns | Redis 8 via Bun `RedisClient`                                                      |
| Web panel         | React 19 served by `Bun.serve`, Redis pub/sub to the bot                           |
| Validation        | zod (environment, Riot API responses, panel protocol)                              |
| Quality           | Biome, TypeScript strict, Husky git hooks, GitHub Actions                          |

## Repository layout

```
apps/
  bot/              the bot process: composition root, Discord adapters, slash command deploy
  web/              the owner's web panel: JSON API, WebSocket and a React page (ADR 9)
packages/
  core/             module system: commands (slash + prefix), events, registry, dispatcher, logger
  db/               SQL migrations, migration runner, repositories (Bun.SQL)
  kv/               KeyValueStore and PubSub ports with Redis and in-memory adapters
  web-protocol/     commands and events between the panel and the bot (zod schemas, client, server)
modules/
  general/          ping, help (interactive menu: categories, pages, install links)
  dzajco/           answers "what" in any language with the DŻAJCO gif, also in threads, voice chats and DMs with the bot (dzajco show, set, reset)
  settings/         prefix (set, reset, show), timezone (set, reset, show), modules (list, disable, enable)
  welcome/          welcome (set through a form, off, test), greets new members
  birthday/         birthday (set, remove, show, channel through a form, test, disable), wishes members on their birthday on servers and in a DM
  fun/              czy_wiedziałeś, time
  party/            party (create and edit through a form, delete, lock, unlock, limit, rename, invite, special invite with a message and attachment, block, hide, show), a voice channel per member who joins the party area
  moderation/       ban, kick, timeout, untimeout, warn, warnings, purge (every action stored with its reason)
  schedule/         schedule (list, exclude, include, song), plays "Lato z Radiem" at 9:00 and 21:00 in the busiest voice channel
  messages/         messages (add through a form, list, remove), dm (on, off): scheduled messages to channels or members' DMs at a set time
  status/           rotates the bot's activity (the old bot's song)
  music/            play (p), search, queue, skip, stop, pause, resume, nowplaying (np), loop, shuffle, seek, volume, filter, remove, jump, back, clear, save (sv), a now playing panel with buttons
  riot/             valorant, lol (player stats from the Riot API, needs RIOT_VALORANT_API_KEY / RIOT_LOL_API_KEY)
infra/              docker-compose files: development (Postgres, Redis, Lavalink and yt-cipher in profile "music") and production (docker-compose.prod.yml)
Dockerfile          the bot compiled into one binary (docs/DEPLOYMENT.md)
scripts/            git hooks and GitHub automation (Bun scripts)
docs/               design doc and ADRs
```

## Getting started

Requirements: Bun ≥ 1.4.4, Docker, a Discord application with a bot user
([developer portal](https://discord.com/developers/applications)). In the portal, turn on the
**Message Content** intent, or prefix commands will not see any messages, and the
**Server Members** intent, or welcome messages are never sent (the bot does not receive member joins).

```bash
bun install                       # also installs the git hooks
cp .env.example .env              # fill in DISCORD_DEV_TOKEN + DISCORD_DEV_CLIENT_ID (test bot) or DISCORD_TOKEN + DISCORD_CLIENT_ID, and DISCORD_DEV_GUILD_ID
bun run infra:up                  # Postgres :5432, Redis :6379
bun run dev                       # the bot, restarted on file changes; migrates and registers its slash commands
```

The party module needs these permissions for the bot in the server: **Manage Channels** (create, rename and
delete channels), **Move Members** (put a member into their channel, disconnect a blocked one) and
**Manage Roles** (the bot edits permission overwrites on party channels; without it a party channel is still
created, but its owner cannot lock or hide it safely). The command channel is the text chat of the join
channel, where the bot needs **Send Messages** and **Embed Links** (the panel), **Read Message History**
(finding leftovers on startup) and **Manage Messages**. With Manage Messages the bot deletes the messages
there after 15 seconds; without it the panel still works and the chat is just not cleaned.

The music module needs Lavalink as well:
`docker compose --env-file .env -f infra/docker-compose.yml --profile music up -d` (port 2333), with
`LAVALINK_URL` and `LAVALINK_PASSWORD` in `.env`. The profile also starts yt-cipher, which deciphers
YouTube stream signatures for Lavalink (ADR 4). Both variables are optional: without them, or while the node is
down, the bot runs normally and music commands answer that the player is unavailable. In the voice channel
the bot needs **Connect** and **Speak**, and **Send Messages** and **Embed Links** in the text channel where
music was started (the now playing panel).

The schedule module plays the songs in `infra/lavalink/music` through Lavalink's `local` source (ADR 4), so
Lavalink needs that directory mounted; a Lavalink container created without it is recreated with
`docker compose --env-file .env -f infra/docker-compose.yml --profile music up -d --force-recreate lavalink`.
At 9:00 and 21:00 on each server's clock the bot joins the voice channel with the most people there, unless
music is already playing. Servers manage it with `/schedule` (Manage Server) or switch it off with
`/modules disable schedule`. `/timezone` sets a server's clock (default `DEFAULT_TIME_ZONE`, Europe/Warsaw);
`SCHEDULED_SONG_CRON` changes the times.

`RIOT_VALORANT_API_KEY` and `RIOT_LOL_API_KEY` are optional and independent: Riot issues a key per game. Without a key
its command (`/valorant` or `/lol`) answers that stats are off while the other keeps working. A development
key from the [Riot developer portal](https://developer.riotgames.com) is enough for `/lol`; Valorant match
history needs a production key (ADR 8).

## Scripts

| Command                       | What it does                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bun run dev`                 | bot in watch mode                                                                                        |
| `bun run start`               | bot without watch                                                                                        |
| `bun run web:dev`             | web panel in watch mode                                                                                  |
| `bun run web:start`           | web panel without watch                                                                                  |
| `bun run commands:deploy`     | register slash commands without starting the bot (optional: the bot does it on start)                    |
| `bun run check` / `check:fix` | Biome lint + format                                                                                      |
| `bun run typecheck`           | `tsc` for the scripts and every workspace                                                                |
| `bun test`                    | all tests (DB / Redis tests need `TEST_DATABASE_URL` / `TEST_REDIS_URL`)                                 |
| `bun run db:new <name>`       | new empty migration `packages/db/migrations/NNNN_<name>.sql`; list it in `packages/db/src/migrations.ts` |
| `bun run db:migrate`          | apply migrations without starting the bot (optional: the bot does it on start)                           |
| `bun run infra:up` / `down`   | start / stop the local services                                                                          |
| `bun run prod:up` / `down`    | build the checked-out commit and start production, or stop it ([deployment](docs/DEPLOYMENT.md))         |
| `bun run prod:logs`           | follow the production bot's log                                                                          |
