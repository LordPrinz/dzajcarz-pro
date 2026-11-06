# Dżajcarz

Discord bot for a group of friends: music from YouTube and other sources (Lavalink), party voice channels
created on demand, moderation, welcome messages and a few running jokes. Every command works both as a
slash command (`/ping`) and with a prefix (`!ping`, the prefix is set per server).

This is v5, a rewrite on Bun. The earlier versions live on the `main`, `dzajcarzv4` and `release/botv3`
branches and are kept as history only.

- **Architecture & decisions:** [docs/DESIGN.md](docs/DESIGN.md)
- **Workflow & conventions:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Wiki:** generated from these docs on every merge to `v5` ([`wiki.yml`](.github/workflows/wiki.yml)); edit the files in this repository, not the wiki
- **Board:** GitHub Projects → _Dzajcarz_ (private)

## Stack

| Layer             | Tech                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| Runtime / tooling | [Bun](https://bun.com) 1.4: package manager, test runner, `Bun.SQL`, `RedisClient` |
| Discord           | discord.js 14                                                                      |
| Music             | Lavalink 4 with the YouTube source plugin                                          |
| Database          | PostgreSQL 17 via `Bun.SQL`, plain SQL migrations                                  |
| Cache / cooldowns | Redis 8 via Bun `RedisClient`                                                      |
| Validation        | zod (environment, later command input from the dashboard)                          |
| Quality           | Biome, TypeScript strict, Husky git hooks, GitHub Actions                          |

## Repository layout

```
apps/
  bot/              the bot process: composition root, Discord adapters, slash command deploy
packages/
  core/             module system: commands (slash + prefix), events, registry, dispatcher, logger
  db/               SQL migrations, migration runner, repositories (Bun.SQL)
  kv/               KeyValueStore port with Redis and in-memory adapters
modules/
  general/          ping, help
  …                 music, party, moderation, welcome, fun (see the board)
infra/              docker-compose: Postgres, Redis, Lavalink (profile "music")
scripts/            git hooks and GitHub automation (Bun scripts)
docs/               design doc and ADRs
```

## Getting started

Requirements: Bun ≥ 1.4.4, Docker, a Discord application with a bot user
([developer portal](https://discord.com/developers/applications)). In the portal, turn on the
**Message Content** intent, or prefix commands will not see any messages.

```bash
bun install                       # also installs the git hooks
cp .env.example .env              # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_DEV_GUILD_ID
bun run infra:up                  # Postgres :5432, Redis :6379
bun run db:migrate
bun run commands:deploy           # register slash commands (dev guild: instant)
bun run dev                       # the bot, restarted on file changes
```

The music module needs Lavalink as well:
`docker compose --env-file .env -f infra/docker-compose.yml --profile music up -d` (port 2333).

## Scripts

| Command                       | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| `bun run dev`                 | bot in watch mode                                                        |
| `bun run start`               | bot without watch                                                        |
| `bun run commands:deploy`     | register slash commands (in `DISCORD_DEV_GUILD_ID`, or globally)         |
| `bun run check` / `check:fix` | Biome lint + format                                                      |
| `bun run typecheck`           | `tsc` for the scripts and every workspace                                |
| `bun test`                    | all tests (DB / Redis tests need `TEST_DATABASE_URL` / `TEST_REDIS_URL`) |
| `bun run db:new <name>`       | new empty migration `packages/db/migrations/NNNN_<name>.sql`             |
| `bun run db:migrate`          | apply migrations                                                         |
| `bun run infra:up` / `down`   | start / stop the local services                                          |
