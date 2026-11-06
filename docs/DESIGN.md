# Design

Living document. Record a decision here when it changes; larger ones get an ADR in [`adr/`](adr).

## Goals

1. Bring back what the old bot did (music, party voice channels, welcome messages, moderation, Dżajco)
   on a codebase that is easy to extend one feature at a time.
2. Every command works as a slash command and as a prefix command, defined once.
3. A feature is a module: adding one does not touch the others, and it can be tested without Discord.

## Components

```
Discord gateway ──▶ apps/bot ──▶ registry ──▶ modules (general, music, party, …)
                      │                          │ ports
                      ├──▶ Postgres (guild settings, warnings, …)
                      ├──▶ Redis (prefix cache, cooldowns)
                      └──▶ Lavalink ──▶ YouTube, SoundCloud, …  (music only)
```

| Package     | Depends on                  | Notes                                                                           |
| ----------- | --------------------------- | ------------------------------------------------------------------------------- |
| `core`      | discord.js (event types)    | Command and module model, registry, prefix parser, dispatcher, logger. No I/O.  |
| `db`        | `Bun.SQL`                   | Plain SQL migrations, a small migration runner, repositories, row types.        |
| `kv`        | Bun `RedisClient`           | `KeyValueStore` port, Redis adapter, in-memory fake, shared contract tests.     |
| `modules/*` | `core` + ports they declare | One feature each. Never import `apps/bot`, `db` clients or another module.      |
| `apps/bot`  | all of the above            | Composition root and the only place that touches discord.js objects at runtime. |

## Key decisions

### One command, two invocations

A command declares its options once (`defineCommand`). The slash form is generated from that definition
(`toSlashCommand`); the prefix form parses positional arguments in the same order (`parsePrefixArgs`).
Modules only see `CommandContext`: typed `args`, the caller, `reply`, `defer`. Required options must come
before optional ones, and only the last string option may take "the rest of the line" (`rest: true`),
which keeps both forms unambiguous. See ADR 5.

### Errors

`UserError` messages go to the caller as they are (Polish). Any other error is logged with the command,
guild and user, and the caller gets a generic message. Event handlers are wrapped the same way, so one
failing module cannot take the process down.

### Prefix per guild

The prefix is stored in `guild_settings.prefix` (null means the default from `BOT_PREFIX`) and cached in
Redis for 10 minutes, because every message in every guild needs it. If Redis is down the bot reads
Postgres; if Postgres is down too it uses the default. Mentioning the bot always works as a prefix.

### Mentions

The client and every reply set `allowedMentions: { parse: [] }`. Commands echo user input (song titles,
reasons), and nothing the bot says should ping `@everyone`, a role or a user unless a command opts in.

### Text in two languages

Code, docs and logs are English. Everything users read on Discord is Polish.

### Music

Audio goes through Lavalink (ADR 4). The music module talks to a small `MusicPlayer` port, so tests run
without a Lavalink node and the client library can be swapped.

## Testing

- `core` and modules: unit tests with `createFakeContext`, no Discord connection.
- `db`: integration tests against a real Postgres (`TEST_DATABASE_URL`), each run in a fresh schema.
- `kv`: one contract suite for every adapter; the Redis run needs `TEST_REDIS_URL`.
- CI provides both services, so nothing is skipped there.
