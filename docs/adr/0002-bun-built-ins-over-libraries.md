# 2. Bun built-ins over libraries

- **Status:** accepted
- **Date:** 2026-11-06

## Context

Bun 1.4 ships a Postgres client, a Redis client, cron and a test runner. The old bot used mongoose,
the `redis` package, `cron`, jest and ts-node, each with its own setup and upgrade cycle.

## Decision

| Need      | Use                                 | Instead of            |
| --------- | ----------------------------------- | --------------------- |
| Postgres  | `Bun.SQL` + plain `.sql` migrations | Drizzle / Prisma / pg |
| Redis     | `RedisClient`                       | ioredis / node-redis  |
| Schedules | `Bun.cron`                          | cron / node-schedule  |
| Tests     | `bun:test`                          | Jest / Vitest         |

Libraries stay where Bun has no equivalent: discord.js (gateway and REST), a Lavalink client (ADR 4),
zod (validation).

## Consequences

- Fewer dependencies and one runtime to learn.
- No ORM: queries are tagged-template SQL, row types in `packages/db/src/types.ts` are maintained by hand
  next to the migrations, and DB tests run against a real Postgres in CI.
