# 3. Redis for ephemeral shared state

- **Status:** accepted, amended by [ADR 9](0009-web-panel-as-a-separate-process.md) (`PubSub` port)
- **Date:** 2026-11-06

## Context

The bot reads the guild prefix on every message, and commands will need cooldowns and rate limits.
Reading Postgres for each message is wasteful; keeping it in process memory resets on every restart and
breaks once the bot runs more than one shard process.

## Decision

- Redis holds only state that can be lost: caches (guild prefix), cooldown and rate-limit counters.
- Code reaches it through the `KeyValueStore` port in `packages/kv` (`get`, `set` with TTL, `del`, atomic
  `increment`, `ping`). Tests use the in-memory adapter; the same contract suite runs against a real Redis
  when `TEST_REDIS_URL` is set.
- The client runs with `enableOfflineQueue: false` and reconnects in the background, so while Redis is
  down commands fail at once and callers fall back (the prefix resolver reads Postgres).
- Durable data (settings, warnings, saved playlists) lives in Postgres.

## Consequences

- One more service in Docker Compose and CI. Locally its password comes from `REDIS_PASSWORD` in `.env`.
- Losing Redis loses caches and counters only, so it needs no backup.
