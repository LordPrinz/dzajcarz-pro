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

### Subcommands

A command groups actions with `subcommands` (`/prefix set`, `!prefix set ?`) instead of `options` and
`run`; the registry rejects both or neither. There is one level, no groups. Each subcommand is built with
`defineSubcommand` and has its own typed `options`. Slash commands map them to `SUB_COMMAND` options; for
the prefix form the first word picks the subcommand and a missing or unknown one gets a Polish error that
lists the valid names. The chosen name travels as `ctx.subcommand`. Command `permissions` also become
Discord's `default_member_permissions`; a subcommand's `permissions` are checked only when it runs.

### Module ownership and shutdown

The registry remembers which module registered each command (`moduleOf`) and each event handler
(`events()` returns `{ module, handler }`), so the bot can apply per-guild module toggles in one place
instead of every module checking its own switch. A module may declare `dispose()`; `apps/bot` calls it
for every module on shutdown, before the Discord client is destroyed.

### Errors

`UserError` messages go to the caller as they are (Polish). Any other error is logged with the command,
guild and user, and the caller gets a generic message. Event handlers are wrapped the same way, so one
failing module cannot take the process down.

### Prefix per guild

The prefix is stored in `guild_settings.prefix` (null means the default from `BOT_PREFIX`) and cached in
Redis for 10 minutes, because every message in every guild needs it. If Redis is down the bot reads
Postgres; if Postgres is down too it uses the default. Mentioning the bot always works as a prefix.

### Module toggles

A server can switch a module off entirely or in chosen channels (`/modules disable <module> [channel]`).
Rows live in `module_disabled` (`channel_id = ''` means the whole guild) and a guild's set is cached in
Redis as JSON for 10 minutes, with the same fallbacks as the prefix, except that when Postgres is down too
every module counts as enabled. The check is central, not in the modules: `bot.ts` asks the gate before a
command runs (slash answers ephemerally, prefix stays silent) and wraps every event handler, using
`eventScope` to find the guild and channel of the event. Events that are not in `eventScope` and events
outside a guild are never gated. `general` and `settings` cannot be disabled.

### Welcome messages

`welcome_config` holds one row per guild: the channel and a template of at most 2000 characters (Discord's
message limit). `renderWelcome` fills `{user}`, `{username}`, `{server}` and `{memberCount}` in a single
pass, so substituted text is never re-expanded and unknown placeholders stay as written. The
`guildMemberAdd` handler skips bots and never throws: a missing config, channel or permission is a logged
warning. It needs the privileged `GuildMembers` intent. The welcome sender is the one place that overrides
`NO_MENTIONS`: it allows a ping for the joining member only (`allowedMentions: { users: [memberId] }`).

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
