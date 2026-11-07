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

### Buttons, select menus and pagination

Replies carry `components` as plain data; handlers are `defineButton` / `defineSelect` on
`BotModule.components`. A click is routed by `custom_id` (`<module>:<component>:<owner>:<data>`), checked
against the module toggle like a command, and refused ephemerally for anyone but the member who ran the
command (`owner`). Small state rides in `<data>`; larger state goes to `KeyValueStore` for 15 minutes and
an expired one answers "To menu wygasło". `createPaginator` renders `◀ | Strona N/M | ▶`. Slash and prefix
replies work alike. See ADR 6.

### Private commands

A command's `contexts` say where it runs (`guild`, `bot-dm`, `private-channel`) and for which install
(`guild`, `user`); the default is guild only. `/help` and `/ping` run everywhere, the other modules stay in
servers. The deploy sends `integration_types` and `contexts` for global commands and leaves them out for
the dev guild. Prefix commands in a DM use the default prefix; a guild-only command answers "Ta komenda
działa tylko na serwerze.". With only the user install the bot cannot post in the channel, so replies go
through the interaction. See ADR 7.

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
outside a guild are never gated. A thread has no toggle of its own and follows its parent channel, both for
events and for commands. The lookup is bounded to 1.5 s (Discord wants an answer to an interaction within
3 s); a slower lookup counts as enabled. `/modules` only accepts channels the guild really has, checked
through the `GuildChannels` port. `general`, `settings` and `status` cannot be disabled (the last has no per-server behaviour to switch).

### Welcome messages

`welcome_config` holds one row per guild: the channel and a template of at most 2000 characters (Discord's
message limit). `renderWelcome` fills `{user}`, `{username}`, `{server}` and `{memberCount}` in a single
pass, so substituted text is never re-expanded and unknown placeholders stay as written. The
`guildMemberAdd` handler skips bots and never throws: a missing config, channel or permission is a logged
warning. It needs the privileged `GuildMembers` intent. The welcome sender is the one place that overrides
`NO_MENTIONS`: it allows a ping for the joining member only (`allowedMentions: { users: [memberId] }`).

### Party areas

`/party create <name>` makes a category and a join voice channel and stores them in `party_area`
(`join_channel_id` is the key, `category_id` is unique). Joining the join channel creates a voice channel
named "Kanał {name}" in that category, stores it in `party_channel` and moves the member into it. The bot
needs Manage Channels (create and delete channels), Move Members (put the member into their channel) and
Manage Roles (permission overwrites on the channels it makes); `/party create` says so when Discord refuses. A member owns **one party channel per server**, across all
areas (`UNIQUE (guild_id, owner_id)`): joining again moves them back to it. A composite foreign key keeps
a channel's `guild_id` equal to its area's. `create` and `delete` need Manage Channels for the caller. That check is on the subcommands, not on `/party`
itself, because a command-level permission would hide the owner controls from regular members.

Owner controls are further subcommands: `lock`, `unlock`, `limit <0-99>`, `rename <name>`, `invite <user>`,
`block <user>`, `hide`, `show`. The caller must be in a party channel (their current voice channel, from
`PartyChannels.voiceChannelOf`) and own it or have Manage Channels; otherwise a `UserError`. The module
changes Discord only through the `PartyPermissions` port: `lock`/`unlock` set `Connect` on `@everyone` to
deny or clear, `hide`/`show` do the same with `ViewChannel`, `invite` and `block` write a member overwrite
(allow or deny both), and `block` also disconnects the member when they are inside. `invite` and `block`
refuse the caller, the bot and non-members, and `block` also refuses the owner and anyone who can moderate
(Administrator, Manage Channels or Move Members in the guild), and only disconnects the member while they are
still in that channel. `unlock` and `show` restore what the category says about `@everyone` (deny, allow or
nothing) instead of clearing the overwrite, so a private area stays private. A new party channel gets an
allow overwrite for the bot itself (View, Connect, Manage Channels, Move Members) and one for its owner, so
locking or hiding never shuts either out; both are best effort: a failure is logged and the channel is kept.
On ownership transfer the new owner gets an overwrite and the old owner's is removed; the database update is
a compare-and-swap on the previous owner. Manage Channels as an override is checked on the party channel
itself (`PartyPermissions.canManage`), not on the channel where the command was typed.

Names are counted in code points (1-100). Discord allows two renames per ten minutes per channel, so the
module counts them in Redis (`party-rename:{channel}`, 2 per 600 s) and refuses with a Polish message before
calling Discord; if Redis is down the rename goes through. Every control command is limited to 10 per
member per minute (`party-ctl:{guild}:{user}`, fail open). Each Discord edit carries the audit-log reason
`Party: <action> by <userId>`, and each successful control action is logged at info level with actor,
action and channel. `/party` is guild-only.

`/party delete` defers first, ephemerally (it makes several Discord calls). `deleteArea` removes the area and its channel
rows in one transaction and returns them; the module then deletes those Discord channels, the join channel
and the category.

Joins are serialised per member by a Redis lock (`party:{guild}:{user}`, `setIfAbsent` with a random token,
30 s TTL, released with `delIfEquals` so an expired lock never frees its new holder); the loser is ignored.
If Redis is down the join goes ahead without the lock and the unique row stops a duplicate. Creating
channels is limited to 3 per member per 60 s (`KeyValueStore.increment`); beyond that the join is ignored
and logged at debug level. Before moving the member the bot checks they are still in the join channel; if
not, a channel made by this attempt is deleted. A failed move deletes the channel only when this attempt
created it, never an existing one that may have people in it.

When the owner leaves a channel that still has people, ownership passes to the first remaining member who
owns no other channel in the server (`transferOwner`); if nobody qualifies the owner stays. Controls built
on the owner (#7) therefore follow whoever is in charge now.

A party channel is deleted when its last person (bots do not count) leaves. The row is dropped only after
Discord confirms the delete (a channel that is already gone counts as deleted); if Discord refuses, the row
stays and the next leave or the next startup retries. `channelDelete` cleans up after manual deletes:
deleting the join channel or the category removes the whole area (its party channels, the join channel and
the category); deleting a party channel removes its row. On `clientReady` the bot drops areas whose join
channel or category no longer exists and removes stored channels that are empty or gone, skipping channels
younger than 15 s so a fresh join is not raced. All handlers log and never throw. It needs the
`GuildVoiceStates` intent, which the client already has.

Cleanup ignores module toggles. Handlers declare `alwaysRun: true` (`EventHandler` in `@dzajcarz/core`) and
`bot.ts` skips the gate for them; party's leave, `channelDelete` and reconcile handlers use it, so
switching the module off never strands empty channels. Only the join handler is gated. The leave handler
runs before the join handler for the same member, which waits for it, so moving from your own channel into
the join channel hands over or frees the old channel first.

### Rotating status

`modules/status` cycles the bot's activity through a list (defaults in `DEFAULT_ACTIVITIES`: the old bot's song, one phrase every 15 s;
both are arguments of `createStatusModule`). The first `clientReady` sets the first activity and starts the
interval; a repeated `clientReady` (reconnect) does not start another, and `dispose()` clears it. It talks to
two ports, `Presence` and `Clock`, so the rotation is tested with a fake clock. A failing `setActivity` is
logged and the next tick tries again. The handler is `alwaysRun`: the status belongs to the bot, not a guild.

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
