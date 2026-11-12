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
                      └──▶ Lavalink ──▶ YouTube, Bandcamp, …  (music only)

Browser ──▶ reverse proxy (Authentik) ──▶ apps/web ──▶ Redis pub/sub ──▶ apps/bot
                                             └──────▶ Postgres (web_audit, archive)
```

| Package        | Depends on                                | Notes                                                                                                                |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `core`         | discord.js (event types)                  | Command and module model, registry, prefix parser, dispatcher, logger, helpers modules share (`helpers.ts`). No I/O. |
| `db`           | `Bun.SQL`                                 | Plain SQL migrations, a small migration runner, repositories, row types.                                             |
| `kv`           | Bun `RedisClient`                         | `KeyValueStore` and `PubSub` ports, Redis adapters, in-memory fakes, shared contract tests.                          |
| `web-protocol` | `kv` (`PubSub`), zod                      | Commands and events between the panel and the bot: zod schemas, `createBotClient`, `createCommandServer`.            |
| `modules/*`    | `core` + ports they declare               | One feature each. Never import `apps/bot`, `db` clients or another module.                                           |
| `apps/bot`     | all of the above                          | Composition root and the only place that touches discord.js objects at runtime.                                      |
| `apps/web`     | `core`, `db`, `kv`, `web-protocol`, React | The web panel: its own process with a JSON API, a WebSocket and a React page. Never imports discord.js.              |

## Key decisions

### One command, two invocations

A command declares its options once (`defineCommand`). The slash form is generated from that definition
(`toSlashCommand`); the prefix form parses positional arguments in the same order (`parsePrefixArgs`).
Modules only see `CommandContext`: typed `args`, the caller, `reply`, `defer`. Required options must come
before optional ones, and only the last string option may take "the rest of the line" (`rest: true`),
which keeps both forms unambiguous. An option with `prefixOnly: true` is left out of the slash command, for
when slash collects that input another way (a modal); `run` then branches on `ctx.canShowModal`. See ADR 5.
In the prefix form a quoted argument may be wrapped in `"…"`, `„…”`, `„…“` or `“…”` (Polish typography and
phone keyboards), so a space can sit inside it; an unmatched opening quote is just part of the word.

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
an expired one answers "To menu wygasło". The state store (`createComponentStateStore`) lives in core; a module
creates one from the storage it is given (music does, through `componentState` in the composition root). `createPaginator` renders `◀ | Strona N/M | ▶`; its `data` shares the
100-character `custom_id` with the names, the owner id and the page number, so keep it short or pass a state
store key. A click that the handler leaves unanswered is acknowledged automatically. Slash and prefix
replies work alike. See ADR 6.

`defineUserSelect` adds a single-choice user select (`{ type: "user-select" }`, a whole row); the handler
gets the chosen id in `ctx.values`. A component declared `public: true` skips the owner check: its
`custom_id` carries `PUBLIC_OWNER` (`*`) and anyone may press it, so the handler must act on `ctx.user`.
`guildOnly`, `permissions` and the module toggle still apply, and a component without `public` refuses
everyone for the `*` owner. The adapter also checks that the interaction type (button, string select, user
select) matches the component's kind before running it.

### Modals

`defineModal` describes a form (up to 5 text, select, channel, user or file fields) as plain data; the module opens it
with `ctx.showModal(modal.build(ctx.user.id, data))` from a slash command or a button/select handler and
gets typed `ctx.values` in `run`. The submit is routed like a click (`<module>:<modal>:<owner>:<data>`,
owner, permissions and module toggle checks), invalid input is answered with an ephemeral Polish message.
Prefix commands cannot open modals: `ctx.canShowModal` is false and the argument form stays. Limits are
checked at startup by the registry. A user field can take several people (`minValues`/`maxValues`, handed over as
`string[]`) and a `file` field is one upload whose type and size are checked on submit (`ModalFile`: url, name,
contentType, size). See ADR 6.

### Private commands

A command's `contexts` say where it runs (`guild`, `bot-dm`, `private-channel`) and for which install
(`guild`, `user`); the default is guild only. `/help` and `/ping` run everywhere, the other modules stay in
servers. The bot deploys its commands itself on start, to the dev guild if one is set, else globally, and
only when Discord's set differs: both sides are reduced to the fields `toSlashCommand` sends, with
Discord's defaults filled in (it leaves out empty `options` and `required: false`). `COMMANDS_AUTO_DEPLOY`
turns it off; `commands:deploy` does the same PUT by hand. With `DEPLOY_GLOBAL` the bot deploys globally and
empties the dev guild, like the script. In dev guild mode it leaves the global set alone and logs a warning
when that set is not empty (members of the dev guild would see every command twice). The deploy sends
`integration_types` and `contexts` for global commands and leaves them out for the dev guild. Prefix
commands in a DM use the default prefix; a guild-only command answers "Ta komenda działa tylko na
serwerze.". With only the user install the bot cannot post in the channel, so replies go through the
interaction. Contexts carry the exact `place`, so a group DM is never mistaken for the DM with the bot.
See ADR 7.

### Help

`/help` (or `!help`) opens an ephemeral menu: a start page with the categories (modules) and their command
counts, a select to open one, and "Dodaj na serwer" / "Dodaj na konto" link buttons built from the client
id. A category lists its commands six per page (`createPaginator`), each subcommand as its own entry with
the slash and the prefix syntax; the select stays so the user can switch, and "Strona główna" goes back.
The state is the category name in the `custom_id` (plus the page), so nothing is stored. Every render
recomputes what the caller may see: commands and subcommands behind permissions the member lacks are
hidden (administrators see all), so are modules switched off in the channel (the module gate behind the
`moduleEnabled` port; a thread follows its parent) and commands whose `contexts` do not allow the place. Places
match exactly: a DM with the bot lists the commands that allow `bot-dm`, a group DM those that allow
`private-channel`. In a server where the bot is not a member (user install) and in a group DM the menu
shows slash syntax only and reads neither the prefix nor the toggles; the gateway also skips the module gate
for such servers. The start page hint names the form the member typed (`!help komenda` or `/help komenda`).
The registry allows at most 25 modules, the size of one select menu. `/help <command>` shows one
command with the same filters; an unknown or hidden name gets the same "not found" answer.

### Errors

`UserError` messages go to the caller as they are (Polish). Any other error is logged with the command,
guild and user, and the caller gets a generic message. On slash both are private even after a public
`defer()`: the adapter sends an ephemeral follow-up, then deletes the deferred reply (a failure in either step is
only logged). A prefix reply cannot be ephemeral, so it is a normal reply. Event handlers are wrapped the same way, so one
failing module cannot take the process down. An unhandled rejection is logged and the process keeps
running; an uncaught exception is logged and the process exits with code 1, so the container's restart
policy starts a clean instance.

### Web panel

`apps/web` is the owner's web panel (epic #143): its own process and container, behind a reverse proxy with
Authentik, with a JSON API, a WebSocket and a React page. The bot keeps the Discord gateway; the panel reads
the Postgres data it owns (`web_audit`) and the message archive, and talks to the bot over Redis pub/sub,
each with its own least-privileged login. Modules do not know the panel exists: the bot side is one adapter,
`apps/bot/src/web-bridge.ts`, and the commands and events both sides share live in `packages/web-protocol`.
The decisions behind it (trust model, protocol, audit log) are in
[ADR 9](adr/0009-web-panel-as-a-separate-process.md), mentions in
[ADR 10](adr/0010-mentions-from-the-web-panel.md), running it in [deployment](DEPLOYMENT.md).

### Message archive

The bot keeps a copy of the messages of the servers the owner picks in the panel (#145), for the panel to
read. It is off for every server and for DMs until switched on, and a server can exclude channels (a thread
follows its parent). The bot archives what it sees from then on, bot messages included; "Wczytaj starsze" in
the panel asks the bot to page one channel's history back from the oldest stored message, at most two pages
of 100 per call, and to store what is missing. Backfill only goes back from the oldest stored message, so
messages sent while the bot was down, after archiving began, are not filled in. An edit moves the previous content, attachments and embeds to
`archived_message_version` (a link preview arriving changes the row in place); a delete sets `deleted_at` and
keeps the row; attachments are stored as links and metadata. There is no retention limit, and the archive
outlives the bot leaving a server, while that server's archive settings are deleted with its other data.

The recorder (`apps/bot/src/archive-recorder.ts`) is panel infrastructure, not a module: it has its own
listeners in `apps/bot/src/discord/archive.ts`, and a failed write is logged without reaching any other
handler. Events of one message run in order, so a delete cannot overtake the insert of its create. A server
message whose channel the bot cannot resolve is skipped, since it might sit in a thread of an excluded
channel. Settings live in Postgres (`archive_settings`, `archive_dm_settings`) and are cached in Redis like
the guild prefix (`createGuildSettingCache`); the panel changes them only through the bot
(`archive.guild.set`, `archive.dm.set`), which refreshes its cache, so a change applies to the next message.
The panel reads the archive and the settings straight from Postgres with `SELECT` rights only.

### Reading in the panel

The panel's main view (#146) is a sidebar with the servers, their channels and threads (`guilds.channels`) and
the DM conversations, next to one open channel. An archived channel is read from Postgres in pages of 50,
keyed on `(created_at, message_id)`, so it reads while the bot is down; at the start of the archive,
"Wczytaj starsze z Discorda" runs the backfill. Any other channel is read live from Discord through the bot
(`channel.messages`) and stored nowhere. A page carries a small map of names for the users, roles and
channels its messages mention: from the bot's caches when it is up, and for users from the archive's author
snapshots otherwise.

The bot publishes every message it sees as an event (`message.created`, `message.updated`,
`message.deleted`), archived or not. The panel forwards an event only to the WebSockets subscribed to that
channel, so the open channel updates live in both cases; a deletion keeps the message on screen, marked.
Edited archived messages show their earlier versions from `archived_message_version`.

Search is Postgres full text over the archive's `search` column (`websearch_to_tsquery('simple', …)`), newest
first, 25 per page, with filters for server or DMs, channel, author and date range. A result opens its channel
around that message. Search covers everything stored, but reading a channel needs it to be archived now. The
panel's database role has a 5 s statement timeout (migration 0017).

Message text goes through a small Discord-markdown renderer in the page (`apps/web/src/ui/markdown.tsx`) that
builds React elements only: no HTML from a message ever reaches the DOM, links are made only from `https:`
URLs, and images and video load only from Discord's media hosts. Long channels use a small virtualised list
of our own (`VirtualList.tsx`), so only the rows near the viewport are in the DOM.

The DM list is the union of the DMs in the archive and the DM channels discord.js has cached (`dms.list`).
Discord gives a bot no list of its conversations, so after a restart a DM outside the archive shows up only
once a message arrives in it.

### Music in the panel

"Muzyka" in the panel (#148) is the player of `/music` for any server: pick a server and a voice channel,
and the bot joins it or moves there, also while people listen. Search YouTube or paste a link (the links
`/play` takes), add single results or a whole playlist, reorder the queue with up and down, remove, shuffle
and clear it; pause, skip, seek on the progress bar, loop, filter, volume and disconnect. The panel acts as
the owner: none of the member rules apply, so it also controls the scheduled song that members cannot pause
or skip. It goes through the same `MusicPlayer` as the module, so the Discord panel and the web page always
show the same state, and the page follows changes live over the WebSocket. While Lavalink is down, or the
bot is offline, the page says so and the controls are disabled. Every change goes through the audit log.
Details in [ADR 9](adr/0009-web-panel-as-a-separate-process.md).

### Writing as the bot

Under the open channel the panel has a composer (#147): text up to 2000 characters, an optional reply to a
chosen message, up to 10 files, and a "Pinguj" switch that is off for every new message. Ctrl+Enter (Cmd+Enter
on a Mac) sends. Hovering a message offers reply, react (a few common emoji or any unicode or custom one),
edit for the bot's own messages and delete. The panel asks the bot what it may do in the channel
(`channel.info`), but the bot checks its permissions again on every action and answers a refusal with a
reason the panel shows in Polish: deleting someone else's message needs Manage Messages, a reply and a
reaction need Read Message History, files need Attach Files. Nobody's messages but the bot's can be edited.
The draft stays in the page and in `localStorage` until the bot confirms the message, so a bot that is down
or a refusal never loses it. The result appears through the live events, like any other message.

Mentions follow [ADR 10](adr/0010-mentions-from-the-web-panel.md): `panelMentions` in
`apps/bot/src/discord/web-writing.ts` is the only code that builds `allowedMentions` for a panel message.

Files do not fit in a pub/sub message, so the page sends each one raw to the panel, which stores it in the
`web_upload` table; the message command carries only their ids. The bot checks their sizes first, all files
together against the target's upload limit (the server's boost tier, 10 MiB in a DM, at most 25 MiB), and
only then loads and sends them. The page checks the same limits before uploading. A message is sent with a
nonce the page keeps per draft and `enforceNonce`; the files stay staged after the send, marked with that
nonce, so a retry of the same draft gets them again and Discord answers it with the message it already
created instead of posting it twice. Staged files are deleted after an hour, and the table holds at most
500 MiB at once.

"Nowa rozmowa" searches members of every server the bot shares (or one) by name (`members.search`, at least
two characters, while typing after a short pause) and opens a DM with the one picked (`dm.open`). Every
write, upload and DM opening goes through the audit log.

### Health endpoint

The bot serves a small HTTP endpoint (`Bun.serve`) on `HEALTH_HOSTNAME:HEALTH_PORT` (default
`127.0.0.1:8080`; the Docker image sets `HEALTH_HOSTNAME=0.0.0.0`). `HEALTH_PORT=0` turns it off, and so
does a port that is already taken (a warning is logged and the bot keeps running).

- `GET /health` (readiness) probes the Discord gateway (every shard is ready), Postgres (`select 1`) and
  Redis (`ping`) in parallel, each with a 2 second timeout; a probe that throws or hangs counts as down.
  Concurrent requests share one run. It answers `200` when all three are up and `503` otherwise:

  ```json
  { "ok": false, "checks": { "gateway": true, "postgres": true, "redis": false } }
  ```

- `GET /health/live` (liveness) answers `200 {"ok":true}` whenever the process responds. It is for
  supervisors that restart on no answer; a `503` on `/health` means a dependency is down, which a restart
  alone would not fix.
- Any other path is `404`, any other method `405`.

`bot healthcheck` is a self-check for supervisors without curl: it fetches
`http://127.0.0.1:$HEALTH_PORT/health` and exits `0` on a `200` and `1` otherwise (also when
`HEALTH_PORT=0`). It reads only `HEALTH_PORT`, so it works without the bot's secrets. The Docker
`HEALTHCHECK` runs `bot healthcheck`, so `docker ps` shows the container as unhealthy while a dependency or
the gateway is down. Plain Docker does not restart an unhealthy container; a crash restarts it through exit
code 1 and the restart policy.

### Migrations and the compiled binary

Production runs the bot as one binary from `bun build --compile` ([deployment](DEPLOYMENT.md)). Such a binary
has no `migrations/` directory to scan, so `packages/db/src/migrations.ts` imports every `.sql` file as text
(`with { type: "text" }`) and the bundler embeds them. A test fails when a file in `migrations/` is missing
from that list or its embedded text differs from the file, because the checksum in `schema_migrations` has
to match byte for byte.

The bot applies pending migrations at startup, before it touches the database or logs in, and exits with
code 1 when one fails. A separate migration step or container would add a moving part for a deployment of
one bot. `migrate` holds a Postgres advisory lock on one connection while it runs, so a second caller (a
restarted container that overlaps the old one, or `db:migrate` by hand) waits instead of applying the same
file twice. It waits at most 60 seconds (`lock_timeout`), then fails like any other migration error.

### Cooldowns

`cooldownMs` on a command (or on a subcommand, which wins over the command's value) limits how often one
user can run it, across servers. The dispatcher counts calls with `KeyValueStore.increment` under
`cooldown:<command>[:<subcommand>]:<userId>` after the access checks, so a refused call does not start the
wait, while a run that fails still uses it up. A subcommand that inherits the command's value still gets
its own window. A second call inside the window gets a `UserError` with the seconds left. If the store is
down or silent for 500 ms the command runs anyway and a warning is logged: Redis only holds losable state
(ADR 3).

### Prefix per guild

The prefix is stored in `guild_settings.prefix` (null means the default from `BOT_PREFIX`) and cached in
Redis for 10 minutes, because every message in every guild needs it. If Redis is down or does not answer
within 500 ms the bot reads Postgres; if Postgres is down too it uses the default. Mentioning the bot always works as a prefix.

### Time zone per guild

Every time of day the bot works with is read on the server's own clock: scheduled messages, scheduled
songs, `/time` and the dates in `/warnings`. `/timezone set <zone>` (Manage Server) takes an IANA name in
any case and stores its canonical spelling in `guild_settings.time_zone`; offsets (`+01:00`) and
abbreviations (`CET`) are refused, since Postgres reads a bare offset with the opposite sign. `show` prints
the zone and what its clock reads now, `reset` goes back to `DEFAULT_TIME_ZONE` (`Europe/Warsaw`), which is
also the zone outside servers. The zone must also be known to Postgres (`pg_timezone_names`), whose tzdata
can lack names the runtime accepts; scheduled messages are converted there. There is no autocomplete for the
zone; the option description and the refusal give examples. Modules get the zone through the `GuildTimeZones` port from core; apps/bot
caches it in Redis like the prefix (`createGuildSettingCache`).

### Leaving a server

When the bot is removed from a server (`guildDelete`: kicked, or the server deleted), apps/bot deletes
everything stored for it in one transaction (`createGuildDataRepository().forget`): settings, module
toggles, welcome, party areas and channels, scheduled songs and messages, Dżajco overrides and the
moderation history. Members' opt-outs from the server's scheduled DMs stay (`KEPT_GUILD_TABLES`): they are the
member's choice, and dropping them would let the server DM them again after re-adding the bot. A server that adds the bot again starts fresh. An outage is
`guildUnavailable` in discord.js and deletes nothing; DM rows (`guild_id` NULL) are not touched.
A database test compares `GUILD_TABLES` and `KEPT_GUILD_TABLES` with every table that has a `guild_id`, so a
new one cannot be forgotten. The Redis copies of the prefix, zone and toggles are reloaded right after, so a server that re-adds the bot
at once does not get its old settings back; Dżajco's per-channel cache expires within 10 minutes.

### Module toggles

A server can switch a module off entirely or in chosen channels (`/modules disable <module> [channel]`).
Rows live in `module_disabled` (`channel_id = ''` means the whole guild) and a guild's set is cached in
Redis as JSON for 10 minutes, with the same fallbacks as the prefix, except that when Postgres is down too
every module counts as enabled. The check is central, not in the modules: `bot.ts` asks the gate before a
command runs (slash answers ephemerally, prefix stays silent) and wraps every event handler, using
`eventScope` to find the guild and channel of the event. Events that are not in `eventScope` and events
outside a guild are never gated. `guildMemberAdd` has no channel, so the gate only applies guild-wide
switch-offs; the welcome module then checks the channel it will post to, and the messages module checks
the target channel of each scheduled message. Scheduled DMs are gated on the server only, and `/modules
disable messages <channel>` says so. A thread has no toggle of its own and follows its parent channel, both for
events and for commands. The lookup is bounded to 1.5 s (Discord wants an answer to an interaction within
3 s); a slower lookup counts as enabled. `/modules` only accepts channels the guild really has, checked
through the `GuildChannels` port. `general`, `settings` and `status` cannot be disabled (the last has no per-server behaviour to switch).

### Welcome messages

`welcome_config` holds one row per guild: the channel and a template of at most 2000 characters (Discord's
message limit). `renderWelcome` fills `{user}`, `{username}`, `{server}` and `{memberCount}` in a single
pass, so substituted text is never re-expanded and unknown placeholders stay as written. The
`guildMemberAdd` handler skips bots and never throws: a missing config, channel or permission is a logged
warning. It needs the privileged `GuildMembers` intent. The welcome sender overrides `NO_MENTIONS`
to allow a ping for the joining member only (`allowedMentions: { users: [memberId] }`); scheduled DMs do the
same for their recipient.

### Dżajco

The `dzajco` module answers a message that says "what" in any language with an egg reaction and the DŻAJCO
gif. The word list comes from the old bot, minus the words that are everyday English, German, Spanish or French
(`was`, `me`, `mit`, `que`, ...), which left 100 entries; `normalizeWords` strips zero-width spaces, folds to
NFC lowercase and drops repeats, which leaves 94. The Polish `co` and the deliberate misspellings stay.

`createWhatMatcher` compiles the list into one regex, once. Every character of a word may repeat (`whaaat`)
and inner whitespace is any run of whitespace. Words in scripts written without spaces (Han, kana, Thai, Lao,
Khmer, Myanmar) match anywhere in the text; every other word needs a non-letter, non-mark, non-digit on both
sides, so `whatever` and `somewhat` do not count.

The `messageCreate` handler stops at the first failing check, in this order:

1. a bot or webhook author, or empty text (a DM with the bot is handled like a channel, with the default
   prefix);
2. no word matches (a regex test, so most messages cost no I/O);
3. the text starts with the guild prefix (a command such as `!play what is love`) or with a mention of the bot;
4. the channel's cooldown key is set;
5. the dice roll (`random() * 100 >= chancePercent`) fails;
6. another message took the cooldown key first.

Edits are not handled. A thread keeps its own cooldown key, but with no override of its own it uses the
chance and cooldown length of its parent channel (`DzajcoChannels.parentOf`, read from the client's channel
cache); an override on the thread wins. At most one answer per message. The matcher
collapses runs of one character in the words and in the text (so `whaaat` matches `what` without a quadratic
regex) and searches only the first 2000 characters.

The cooldown lives in Redis under `dzajco:cooldown:<channelId>` (`setIfAbsent` with the TTL, so two messages
racing for it cannot both answer) and starts only when the bot answers. A Redis error fails closed: no gif,
a logged warning, so an outage never turns into gif spam. The default is a 3% chance and 60 s, per channel.

`dzajco_channel_config` holds per-channel overrides (keyed by channel; `guild_id` is NULL for a DM), edited
with `/dzajco set`, `show` and `reset`. On a server they need Manage Server and take any chat of it: text and
announcement channels, threads and the chat of voice and stage channels. The command also runs in DMs with
the bot (guild install only: a user install would offer it in servers without the bot), where it sets only
that conversation and needs no permission, with a cooldown
of at least 10 s (every answer costs two requests against the bot's shared rate limit); because of
that it carries no `permissions` (core allows those only on guild-only commands) and checks Manage Server
itself, so Discord shows it to every member. A channel without a row uses the defaults. The handler reads
settings through a Redis cache (`dzajco:settings:<channelId>`, 10 minutes, an unreadable entry is reloaded);
`set` and `reset` write the new value to that key and end the running cooldown, so new values apply at once. If the invalidation fails, or a read races a
write, the old settings can stay for up to the cache TTL. We accept that. Chance 0 switches the gif off in a
channel. The random source is injected (`Math.random` in `modules.ts`), so the tests are deterministic. The
reaction needs the Add Reactions permission; without it the bot logs a warning and still sends the gif.

### Party areas

`/party create` opens a form (a modal, see Modals) with the category name, the join channel name, a channel
name template and whether the area wants a command channel (a select with "Włączony" / "Wyłączony"). Submitting makes a category and a
join voice channel and stores them in `party_area` (`join_channel_id` is the key, `category_id` is unique, plus
`name_template`, default `Kanał {user}`, `command_channel`, default false, and `panel_message_id`, see Command
channel below). `/party edit [channel]` opens the same form filled with the area's current values
(`PartyChannels.areaNames`); submitting saves the template and the flag first, then renames only the channels whose name changed
(`renameArea`), each checked against the rename limit (2 per 10 minutes) before Discord is called, and the
reply says exactly what was and was not renamed. The `channel` option picks the
area when a server has several. The prefix forms keep arguments: `party create <name>` uses the default
template and no command channel, `party edit` answers that editing needs the slash command. The template must
contain `{user}` and be at most 90 characters; names are at most 100. Joining the join channel creates a voice
channel in that category named by the template, with `{user}` replaced by the member's display name
(whitespace collapsed, cut to 100 characters, never empty), stores it in `party_channel` and moves the member
into it. The bot
needs Manage Channels (create and delete channels), Move Members (put the member into their channel) and
Manage Roles (permission overwrites on the channels it makes); `/party create` says so when Discord refuses. A member owns **one party channel per server**, across all
areas (`UNIQUE (guild_id, owner_id)`): joining again moves them back to it. A composite foreign key keeps
a channel's `guild_id` equal to its area's. `create`, `edit`, `delete` and the area form need Manage Channels
for the caller, from their guild-level roles (`PartyGuild.memberPermissions`; a grant on one channel does
not count, Administrator does). That check is on the subcommands, not on `/party` itself, because a
command-level permission would hide the owner controls from regular members.

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

#### Special invite

`/party invite-special` and the panel's Specjalne zaproszenie button open the same form: members (user select,
1 to 10), title (optional, up to 256), message (optional paragraph, a default invite text when empty), colour
(string select, fixed palette with Polish names, default blue) and an optional attachment (image, video or PDF,
up to 10 MB). Only the **owner** of the party channel the caller is in may open or submit it (Manage Channels is not
enough, the DM goes out in the owner's name); the prefix form answers that it needs the slash command. On submit
the module defers with a private reply (also when the form came from the panel, whose message stays untouched; access
changes and DMs take longer than three seconds), downloads the attachment once through the `PartyInvites` port
(Discord CDN only, size and time limited; if that fails the invites go out without it and the summary says so),
then per distinct member: skips the caller, bots, people who are not on the server, members blocked on the channel
(`PartyPermissions.isBlocked`) and people over their limit, grants access with the same `allowMember` call as
`/party invite`, and sends a DM through the port (the module never imports discord.js). The DM is an embed whose author
line carries the sender's avatar and "Zaproszenie od <display name> (@username) z serwera <server>", then the title,
the owner's message, the channel, and the footer "Treść napisał zapraszający, nie bot." A link button "Dołącz" leads
to the voice channel. The file is a real DM attachment; an image (png, jpeg, gif, webp) is also shown in the embed
through `attachment://<name>`. Closed DMs (the port answers false) and failed ones are collected, not thrown, and
the owner gets an ephemeral summary: delivered, DMs failed, skipped with a neutral reason. A member whose DM failed
**keeps their access** and the summary says so, so the owner can tell them.
Limits (Redis, `party-special:min|hour:{guild}:{user}`, `party-special-to:{guild}:{recipient}`): per owner 1 a minute
and 5 an hour, per recipient 3 an hour from one server. The form refuses to open while the owner is over a limit
(read without counting); the send counts. This action **fails closed**: with Redis down it answers "Specjalne
zaproszenia są chwilowo niedostępne.", unlike the control cooldown, because each use is a DM to up to ten people. All
output uses NO_MENTIONS.

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
on the owner therefore follow whoever is in charge now.

A party channel is deleted when its last person (bots do not count) leaves. The row is dropped only after
Discord confirms the delete (a channel that is already gone counts as deleted); if Discord refuses, the row
stays and the next leave or the next startup retries. `channelDelete` cleans up after manual deletes:
deleting the join channel or the category removes the whole area (its party channels, the join channel and
the category); deleting a party channel removes its row. The whole area goes because party channels outside
their category would be orphaned and an area missing either channel is useless. The bot does this with its
own permissions, so anyone who can delete the join channel or the category (Manage Channels granted by an
overwrite on that one channel is enough) can dismantle the area. That is accepted. On `clientReady` the bot drops areas whose join
channel or category no longer exists and removes stored channels that are empty or gone, skipping channels
younger than 15 s so a fresh join is not raced. All handlers log and never throw. It needs the
`GuildVoiceStates` intent, which the client already has.

Cleanup ignores module toggles. Handlers declare `alwaysRun: true` (`EventHandler` in `@dzajcarz/core`) and
`bot.ts` skips the gate for them; party's leave, `channelDelete` and reconcile handlers use it, so
switching the module off never strands empty channels. Only the join handler is gated. The leave handler
runs before the join handler for the same member, which waits for it, so moving from your own channel into
the join channel hands over or frees the old channel first.

#### Command channel

An area with `command_channel` on uses the text chat of its join voice channel as a command channel. The bot
posts one panel there (an embed plus buttons Zamknij, Otwórz, Ukryj, Pokaż, Limit, Zmień nazwę, Specjalne zaproszenie and two user
selects, Zaproś and Zablokuj) and stores its message id in `party_area.panel_message_id`. The panel is
shared: its components are `public`, so anyone may press them, and each press acts on the presser's own
party channel through the same functions the `/party lock|unlock|hide|show|limit|rename|invite|block`
subcommands call (`controlledChannel`: in the channel, owner or Manage Channels, control cooldown, audit
reason). Replies are ephemeral; a member without a party channel is told "Musisz być na swoim kanale party.".
Limit, Zmień nazwę and Specjalne zaproszenie open a modal (owned by the presser, checked on submit like any modal) after the same
checks, cooldown included. That work runs inside the three seconds Discord gives for answering with a modal
(a later answer fails with 10062), so it stays small: one Redis increment, the cached voice state, one row,
and a member lookup only for someone who is not the owner. The cooldown also stops repeated presses from
becoming a stream of those lookups. The user selects redraw the panel first, which clears the menu's choice,
then answer with a follow-up.

Everything in that chat except the panel and the bot's own messages is deleted 15 seconds after it appears.
The bot's messages stay because commands run from this chat (`/play`, for one) answer here, and deleting the
now-playing panel would make `showPanel` post another one that is deleted in turn. The event carries the
author id; the module compares it with `PartyChat.selfId()`. A `messageCreate` handler schedules the delete through the `Scheduler`
port (`@dzajcarz/core`: `after(ms, task)`, `createScheduler()` is `setTimeout`, `createFakeScheduler()` in
`@dzajcarz/core/testing` is advanced by hand). Messages that fall due within one second of each other are
deleted in one request per channel, so a burst costs one call (the effective delay is 15 to 16 s). The flush
re-reads the area, so a message that turns out to be the panel (its creation event can beat the write of its
id) or a flag switched off meanwhile is left alone. Pinned, system and bot-authored messages are never scheduled; a message
pinned inside the 15 s window is still deleted. `dispose` cancels pending timers; the startup sweep covers
what restarts lose.

Every message in the guild reaches the message handlers, so they first ask an in-memory set of the join
channel ids whose area has the flag on, and return without touching the database for anything else. The set is
built on `clientReady` and updated by `syncPanel`, `/party edit` and `dismantleArea`. The client enables
`Partials.Message`, otherwise `messageDelete` is not emitted for a panel that is not in the cache (after a
restart); the handlers only need the message and channel ids.

The panel is kept in sync by `syncPanel`, one operation per area at a time: it posts a panel when the flag is
on and there is none or `exists` says it is gone, and removes it when the flag is off. It runs after `/party
create` and `/party edit` (a failure is reported in the reply, the settings stay saved), when the panel is
deleted (`messageDelete`, `messageDeleteBulk`) and on `clientReady`, where it also deletes up to 100 leftover
messages (everything but the panel, pinned and system messages). If the area is removed while a panel is
being posted, that panel is deleted again and nothing is reported as the panel. A deleted panel is reposted at
most once per 30 s per area: a second deletion inside the window is held until the window ends, which bounds a
loop against another bot or an automod rule that keeps removing it.

Discord access sits behind the `PartyChat` port (`post`, `exists`, `recentMessages`, `deleteMessages`). The
adapter splits ids by snowflake age: two or more messages under 14 days old are bulk-deleted (in batches of
100), the rest one by one. A bulk delete Discord refuses as a whole (10008, 50021, 50034) is retried one by
one, and a single delete that hits Unknown Message (10008) or a system message (50021) counts as done, so
nothing is deleted twice and nothing throws for a message that is already gone.

Module gate: the cleanup, the panel repost and the startup sweep are `alwaysRun`, like the channel cleanup:
switching the party module off in a channel must not leave a chat that fills up or a panel that vanished.
Only the panel's buttons are gated (they answer that the module is off). The startup sweep covers every area
with the flag. The bot needs Send Messages, Embed Links and Read Message History in the join channel for the
panel and Manage Messages to delete other people's messages (added to the install permissions); without
Manage Messages the panel works and the chat is not cleaned, and the failure is logged once per channel
until a delete works again, not once per message.

### Scheduled songs

`modules/schedule` keeps the old bot's tradition: at 9:00 and 21:00 on each server's clock it plays "Lato z Radiem" in
the most crowded voice channel of every server. It is a module of its own, not part of `modules/music`: it
shares no code with the player's commands, and ADR 5 forbids modules importing each other, so it depends on
narrow ports only.

- `CronScheduler` (`@dzajcarz/core`, `createCronScheduler()` on `Bun.cron` with its `tz` option). The zone
  is part of the schedule, so a run stays at 9:00 local time across the March and October clock changes
  (`cron.test.ts` checks both). Tests fire the schedule by hand.
- `ScheduleVoice`: the servers the bot is in, each voice channel it may join and speak in with its human
  count, the server's AFK channel, and whether an id is a voice channel of the server.
- `ScheduledSongPlayer`: `available()`, `isPlaying(guildId)` (a current or queued track in the player's own
  queue, so a player rejoining after a node restart counts), `play(guildId, voiceChannelId, song)` and
  `leave(guildId)`. `play` resolves `busy` at once when members' music got there first, otherwise once the
  song is over, with whether the queue still holds tracks. `song` is a name from the fixed list in
  `apps/bot/src/music/scheduled-songs.ts`; the adapter maps it to a path under `/opt/Lavalink/music` and
  rejects any other string. It is the only caller of the node's local source (ADR 4).

A run goes through the servers in parallel and handles each on its own: skip it when the audio node is down or
music is playing in it (paused counts; nothing is interrupted), drop empty channels, the AFK channel, excluded
ones and ones where the module is switched off, then take the channel with the most humans (ties go to the
older channel). A server is claimed before the first lookup, so two overlapping runs never both play there.
The player checks the queue once more right before it takes over, with no await in between: a `/play` that
landed during the lookups wins and the song is skipped. After the song the bot leaves, unless something was
queued in the meantime; then the music module's idle timeout takes over. A player that was only lingering
idle in another channel is moved to the target channel, not destroyed and created again: Discord's "left
voice" for the old player would arrive after the new one exists and end it. A failure in one server is
logged and does not stop the others.

The song plays quietly: its track is marked `byBot` (`MusicTrack.byBot`, set by the adapter from the
track's requester), and the music module posts no now playing panel and no failure note for such a track.
The player's text channel is the voice channel until a member joins in. A member who runs `/play` during the
song gets their track queued behind it, and the first such `/play` makes its channel the panel's: once the
member's track starts, the panel appears there as usual. The song plays at the player's volume and with
its effect: an idle player keeps what members set, a new one starts at 100 with no effect. It never
repeats: the adapter keeps the player's loop off while the song plays, so neither the track loop nor the
queue loop replays it. Members cannot pause, skip, stop, seek, loop or replace it: `/pause`, `/skip`, `/stop`,
`/seek`, `/loop`, `/jump`, `/back` and the matching panel buttons answer that it plays to the end (`/resume`, `/volume` and
`/filter` stay open, and a member's own track stays fully controllable). The song has no panel of its own, and a panel
left from before it is removed when the song starts. `/back` during the song
ends it without queueing it again, `/jump` follows the members' loop mode, and `/back` later passes over
the song in the history. The schedule module and the music module never import each other; the flag on
the track is all they share.

Settings (`scheduled_song_config`, `scheduled_song_exclusion`) belong to the server and need Manage Server:
`/schedule list`, `exclude <channel>` (voice channels of the server only), `include <channel>` (also accepts a
deleted channel) and `song [name]` (the fixed list; `song reset` goes back to the default song). The module toggle (`/modules disable schedule`) switches
the song off per server or channel. The schedule defaults to `0 9,21 * * *`; `SCHEDULED_SONG_CRON` changes
it and is checked at startup. One job ticks every minute in UTC; each tick rounds down to its minute (up to
5 s early still counts as the coming one) and plays in every server whose own zone (`/timezone`) makes the
expression fire then (`firesAt` in core). Only servers with someone in voice (read from the gateway cache)
have their zone looked up. On the spring clock change a time that does not exist that day (02:00–02:59 in
Warsaw) does not play; on the autumn change a repeated time plays once, at its first occurrence. Scheduled
messages behave the same.

The old bot's other scheduled entries (messages at fixed times, birthdays) are not part of this module.

### Scheduled messages

`modules/messages` posts a server's own text every day at a set time: in a text or announcement channel of
the server, or as a DM to one of its members. Rows live in `scheduled_message` (time of day as `HH:MM` on
the server's clock, see /timezone, 1 to 1900 characters, exactly one of `channel_id` and `user_id`). `/messages add` (Manage
Server) opens a form with the time, a channel or a member, and the text; the prefix form is
`messages add <HH:MM> <#kanał|@osoba> <tekst...>`. Both go through the same checks: a real time, one target,
a channel of this server that the bot can see and send messages in, or a member who is not a bot. When the
form is refused, the typed text comes back in code blocks. `{user}` in a channel message stays as written,
and the reply says so.

Caps: 25 messages per server, 3 DMs per member per server, and one message per target and time. The
repository checks them and inserts in one transaction that holds a per-server advisory lock
(`pg_advisory_xact_lock`), so two adds at the same moment cannot both take the 25th place. The refusals say
nothing about opt-outs.

`list` shows one line per message, the text as a 40-character inline-code preview (markdown and mentions show
as typed; backticks become `ˋ` so they cannot end the span), cut to fit 2000 characters ("… i jeszcze N").
`remove <id>` only finds messages of the server it runs in. When the bot leaves a server, its messages go
with the rest of its data (see Leaving a server).

Sending is a `CronScheduler` job at `* * * * *` in UTC. A tick does nothing until the Discord client is
ready: before that `botInGuild` sees no servers, and every message would look like one for a server the bot
left. Each tick rounds down to its minute (up to 5 s early still counts as the coming one) and reads at most
500 due rows across all servers (a warning when that is hit; the rest wait for the next minute). A message is
due when its `time_of_day` has passed on the server's clock and the server's local date is later than
`scheduled_message.last_sent_date`. Postgres turns the instant into each server's wall clock
(`guild_settings.time_zone`, else `DEFAULT_TIME_ZONE`), so one query serves every zone; it does not check the
zone against `pg_timezone_names`, since `/timezone` and the startup check already did. Over the limit, the
query takes one message per server before a second from any, and the servers in random order, so a large
server cannot crowd out the others. The tick sends them five at a time. Each row is handled on its own: a
failure is a warning with the row id, and the whole tick is wrapped too. For each row, in order:

- claim the local date: `UPDATE ... SET last_sent_date = <date> WHERE id = <id> AND (last_sent_date IS NULL
  OR last_sent_date < <date>)`. Exactly one tick or instance gets the row, so overlapping or slow ticks and
  a second instance never send a message twice, and a write that fails after the send cannot cause a resend;
- skip a server the bot is no longer in;
- the module toggle: a channel message asks for its channel, a DM for the server as a whole (it has no
  channel), so `/modules disable messages #kanał` stops only messages to that channel;
- a DM goes out only while the recipient is still a member, is not a bot and has not opted out. `{user}`
  becomes a ping of the recipient, a footer names the server (with markdown and mention characters
  stripped from the name), and a "Nie wysyłaj mi więcej" button sits under it. Closed DMs (50007) are
  logged at info.

A skipped server or module, a deleted channel, a member who left or opted out and closed DMs keep the claim:
a retry would not change them. When Discord fails, the claim is given back (the date steps back one day), so
the next minute's tick tries again. The failures of a message on a local date are counted in Redis
(`messages:failed:<id>:<date>`, 26 h TTL; losable state, ADR 3). The 5th failure is logged as an error and
keeps the claim, so that day's message is given up and the next day's goes out as usual. A retry stops at
local midnight: the next day's attempt starts over.

New messages and the migration both start a message whose time has already passed today with today's date,
so adding "19:00" at 20:00 waits for tomorrow, and the deploy does not repeat what the old Redis lock sent
that day. The migration reads each server's zone from `guild_settings`, else `Europe/Warsaw`.

The rule keeps the schedule right across the clock changes and `/timezone`: a minute missed while the bot was
down is sent when it is back, the same day; a time the March change skips goes out right after the jump;
October's repeated 02:xx hour sends once, since the second 02:30 finds the date stored; and a `/timezone`
change mid-day neither repeats a message that already went out (the new zone's date is not later) nor skips
one that did not. One edge stays: moving to a zone that is behind the old one can leave the stored date a day
ahead of the local date, and that day's message is skipped.

The DM can grow past what was typed, so `add` checks the worst case: every `{user}` replaced by the
recipient's mention, plus the footer with a 100-character server name, must fit Discord's 2000 characters.

Opt-outs (`scheduled_message_opt_out`) belong to the recipient, not the server. A row has a guild id, or NULL
for every server (unique with `NULLS NOT DISTINCT`). The button under a DM and `/dm off` on a server opt
out of that server; `/dm off` in a DM with the bot opts out of all of them. `/dm on` removes exactly the
row of the place it runs in. On a server it says so when the every-server opt-out still applies. In a DM it
leaves the per-server ones and points to `/dm on` on that server for them. The button carries the guild id
in its custom_id and checks it is a snowflake before using it; only the recipient can press it.

Channel posts use `NO_MENTIONS`, so an admin's `@everyone` stays text. A scheduled DM is the second exception
after the welcome greeting: `allowedMentions: { users: [recipientId] }`, the recipient and nobody else. The
module reaches Discord through its own ports (`ScheduledMessageSender`, `MessageChannels`) and imports no
other module.

### Rotating status

`modules/status` cycles the bot's activity through a list (defaults in `DEFAULT_ACTIVITIES`: the old bot's song, one phrase every 15 s;
both are arguments of `createStatusModule`). The first `clientReady` sets the first activity and starts the
interval; a repeated `clientReady` (reconnect) does not start another, and `dispose()` clears it. It talks to
two ports, `Presence` and `Clock`, so the rotation is tested with a fake clock. A failing `setActivity` is
logged and the next tick tries again. The handler is `alwaysRun`: the status belongs to the bot, not a guild.

### Fun commands

`modules/fun` holds `/czy_wiedziałeś` (a coin flip: "Wiedział!" with a 🙋‍♂️ reaction, or "Nie wiedział sadge
bruh") and `/time` (the time on the server's clock as `HH:MM:SS`, midnight is `00`; outside servers the
default zone). The random source, the clock and
the zone are injected, so tests pin both answers and the DST changes. `/time` does not mention the caller.
A reply may carry `reactions`, unicode emoji the adapter adds to the sent message. Adding them is best effort:
on a user install or in a group DM the bot cannot react, so a failed reaction is logged at `warn` and never fails the
reply. Only command replies (slash and prefix) apply it; other senders ignore it.

### Mentions

The client and every reply set `allowedMentions: { parse: [] }`. Commands echo user input (song titles,
reasons), and nothing the bot says should ping `@everyone`, a role or a user unless a command opts in.

### Moderation

`modules/moderation` has `/ban`, `/kick`, `/timeout <user> <30s|10m|2h|1d>`, `/untimeout`, `/warn`,
`/warnings` and `/purge <1 to 100>`, all guild only. Each declares its Discord permission (Ban Members, Kick
Members, Moderate Members for timeout, untimeout, warn and warnings, Manage Messages for purge), so the
dispatcher checks prefix calls too. Ban, kick and Moderate Members are guild-wide powers, but the member
permissions Discord hands a command include channel overwrites. The module therefore checks the caller's
role permissions once more through its own `ModerationGuild` port (an administrator passes). Manage
Messages is a channel permission, so purge relies on the dispatcher alone.

Before acting, the module applies Discord's hierarchy rules itself and answers with the reason, in this
order: not yourself, not the bot, not the server owner, not a member whose highest role is equal to or above
the caller's (the owner as caller skips this one), and, when the bot itself acts, not one at or above the
bot's highest role (a warning is only a record, so that one is skipped for it). Another bot that ranks lower
is fair game. Kick, timeout, untimeout and warn need a member. A ban also takes the id of someone who already
left; only the id rules apply then. For ban, kick, timeout and untimeout the bot's own role permissions must
hold the bit (or Administrator), and an administrator cannot be timed out. These checks, the reason length
(at most 512 characters, Discord's audit log limit) and the duration (`parseDuration`, more than 0 and at
most 28 days) all run before `defer()`, so a refusal stays ephemeral and no DM goes out for an action that
cannot happen. The adapter sends a full 28 days as a minute less, because Discord checks the end time against
its own clock and refuses it when the host clock runs ahead. A refusal Discord still sends (Missing
Permissions or Missing Access) becomes a Polish `UserError` in the adapter.

The action comes first, then the record in `moderation_action` (guild, action, moderator, target, reason,
duration for a timeout, channel and count for a purge, time). If the insert fails, the error is logged
and the reply still confirms the action, with "(nie udało się zapisać w historii)" appended: the member
is already banned, so pretending otherwise would be worse. The audit log reason is
`<moderator>: <reason or "brak powodu">`, cut to 512 characters. Replies are public and echo the reason as
typed; NO_MENTIONS keeps `@everyone` and role mentions in it silent.

The target gets a direct message with the server name, the action, the reason and, for a timeout, the
length, worded without grammatical gender ("Ban na serwerze X. Powód: …"). It is best effort: a closed DM or
a failure is logged and never stops the action. For a kick or ban it goes out before the action, because
afterwards the bot may share no server with them; if Discord then refuses the action, a second DM says it
did not happen. For a warn or timeout it follows the action. Untimeout sends none. Warning DMs are limited to
one per member and server every 10 minutes (a `KeyValueStore` key taken with `setIfAbsent`), so a burst of
`/warn` cannot flood an inbox; every warning is still recorded, and if Redis fails the DM goes out anyway.

`/warnings` shows the count and the 10 newest warnings on the server's clock. Each reason is cut to 120
characters, and whole lines are dropped if the text would still pass Discord's 2000 characters; the header
is written after that, so "N najnowszych" matches the lines shown. The slash form answers ephemerally. A
prefix reply would be public, so `!warnings` sends the list to the moderator by DM and only says so in the
channel, or tells them to use `/warnings` when the DM fails.

`/purge` fetches the newest messages of the channel (at most 100), deletes up to `count` of them through
`bulkDelete` (a single message too) and leaves pinned messages and those older than 14 days minus a minute,
which bulk delete cannot remove. The reply says how many of each were skipped. A purge that deleted nothing
is not recorded. The slash form answers ephemerally. The prefix form fetches only messages before its own
command (`before` that message id), so the command stays for the reply to answer and a message that arrives
meanwhile is never touched; `!purge 100` deletes a full 100.

The guild install asks for Ban Members, Kick Members and Moderate Members for this module, and for Add
Reactions, which Dżajco and the fun commands use; see CONTRIBUTING.

### Text in two languages

Code, docs and logs are English. Everything users read on Discord is Polish.

### Music

Audio goes through Lavalink (ADR 4). `modules/music` talks to ports only, so tests run without a node and
the client library can be swapped:

- `MusicPlayer`: `available()`, `search(query, requesterId)` (tracks, a playlist, empty or an error),
  per guild `state()` (voice and text channel, current track, upcoming tracks, position, paused), `join`,
  `enqueue`, `skip(guildId, expectedTrackId)` (a no-op once that track is no longer current or was already
  skipped, so a double click skips one track), `pause`, `resume`, the controls `setLoop`, `shuffle`,
  `seek(guildId, position, expectedTrackId)`, `setVolume`, `setFilter`, `remove`/`jump` (zero-based place plus
  the id the module saw there, so a queue that moved meanwhile is left alone), `previous` (the track, `"none"`
  or `"changed"`), `moveTrack(guildId, from, to, expectedTrackId)`, `moveToChannel` and `clear`, `leave`
  (works without a node), and `subscribe` for `trackStart`, `queueEnd`, `playerDestroyed`, `trackFailed` and
  `stateChanged` (pause, loop, volume, filter, seek, queue edits or a channel move, whoever made them). `jump`, `previous` and `seek` also answer "changed" (false) while a
  skip is on its way, since the track they act on is about to end; the module tells the member to try again.
- `VoiceChannels`: the member's voice channel and the number of people (bots excluded) in a channel, read
  from the gateway's voice state cache.
- `PanelMessages`: post, edit and delete the now playing panel; `edit` answers `"gone"` when Discord says
  the message or channel is unknown, and rejects on any other failure.
- `DirectMessages`: `send(userId, message)`, false when the member's DMs are closed to the bot.
- `Scheduler` (idle timeout) and the component state storage (search results).

Commands are guild-only and answer in Polish: `/play <query>` (`p`), `/search <query>`, `/queue`, `/skip`,
`/stop`, `/pause`, `/resume`, `/nowplaying` (`np`) and the controls below. A query that is an http(s) link (Discord's `<link>`
form is unwrapped) is loaded as a link only when its host is one of youtube.com (plus `www.`, `m.`,
`music.`), youtu.be, bandcamp.com and its subdomains, twitch.tv (plus
`www.`, `m.`) or vimeo.com (plus `www.`, `player.`), compared exactly on the parsed, punycode hostname,
with no user info and no explicit port; the link then goes on in the parser's normalised form, so the node
fetches the host that was checked. Any other link is refused with "Obsługuję tylko linki z YouTube,
Bandcamp, Twitch i Vimeo." Anything else is YouTube search text, sent as `ytsearch:<text>`
straight to `/loadtracks`, so a typed `local:`, `scsearch:` or path never selects a source. The adapter
builds the identifier itself instead of going through the client's search helper, which strips source
prefixes and passes anything starting with `http` through raw. `/play` takes the first search hit, or up to
100 tracks of a playlist, and the queue holds at most 500 tracks (current one included); the reply says how
many were left out. `/search` shows up to ten results in a string select owned by the caller; the results
wait in the component state store (ADR 6) and the pick is checked again against the voice rules.
Additions run one at a time per guild: the voice check (against the channel the caller is in at that
moment, not when the command started), the queue cap, the join and the enqueue happen inside that chain,
so two quick `/play`s join once, never overfill the queue and only the first one answers "Gram:".

Access: the caller must be in a voice channel, and once the bot plays in the guild, in the bot's channel.
Anyone in that channel may control playback (no DJ role, no votes). `/queue` and `/nowplaying` only read and
work for everyone in the server. While no node is connected every control answers "Odtwarzacz muzyki jest
teraz niedostępny.", except `/stop` and the Stop button: they still make the bot leave voice (the player
is dropped locally and the leave goes through the gateway). `/stop` always clears the queue and leaves.
Other modules are unaffected and the bot starts without `LAVALINK_URL` or with the
node offline (the module is then wired to a player that is never available).

Now playing panel: one message per guild in the text channel where music was started, posted on the first
`trackStart` and edited on the next ones and on every `stateChanged`, so a change made from the web panel
shows too. Changes that land before a redraw starts are drawn once, and a control that changes nothing
(pausing a paused player, clearing an empty queue) emits nothing. A click on the panel's own buttons edits
it through the interaction: a change before the click reads the state is in that edit, and one after it
(another member, the web panel) is redrawn once the click is done. It shows the
title (linked), author, cover, progress at that moment, who added the track and the queue length, with
public buttons Pauza/Wznów, Dalej, Stop and Kolejka. The first three check the clicker against the bot's
channel like the commands; Dalej and Stop acknowledge the click first (the skip waits for the node, and
Stop's panel is deleted by `playerDestroyed`). Kolejka opens the paged queue ephemerally for the clicker. A
panel whose message or channel is gone is posted again on the next change; any other edit failure keeps
the panel and is logged. `/nowplaying` while paused says "Wstrzymane · W kolejce: N". A track the node
cannot play gets a note in the panel's channel, "Nie udało się odtworzyć **<title>**, gram dalej.", and the
next one plays. When the bot is removed from a server (`guildDelete`, `alwaysRun`) its player there is
destroyed. It is removed when the queue ends, the player is destroyed and
on shutdown. Panel work runs one at a time per guild, so quick track changes never post two panels.

Controls (same access rules as `/skip`; queue edits, `/loop`, `/filter`, `/seek` and the loop button run in
the per-guild chain that serialises additions, and read the state inside it):
`/loop <off|track|queue>` (the prefix form also takes `wyłącz`/`wyłączona`, `utwór` and `kolejka`; slash
choices have Polish names), `/shuffle` (needs two tracks waiting), `/seek <time>` (`90`, `1:30`, `1:02:03`,
`1m30s`, `1m30`, `1 m 30 s`, `1h2m3s`, up to 99:59:59; in both forms a part after a larger one stays under 60,
and minutes go up to 99 without hours; refused for a stream, for a track whose source cannot seek and past
the track's length, while the end itself is allowed and ends the track; when another track plays by
the time the seek arrives, nothing moves and the member is asked to try again), `/volume <0-150>` (`vol`; 100
is the source's own level and the level the bot joins at), `/filter <bassboost|nightcore|vaporwave|8d|off>`
(the prefix form also takes `bas` and `wyłącz`), `/remove <n>` and `/jump <n>` (n is the place shown by
`/queue`; `/jump` drops the tracks before it, or with the queue loop moves them to the end of the queue),
`/back` (the previous track plays again, the current one waits at the front of the queue), `/clear` (the
current track keeps playing) and `/save` (`sv`: the title, author and link as a DM; anyone in the server may
use it while something plays, like `/queue` and `/nowplaying`; closed DMs are reported ephemerally). The
panel footer shows `Pętla`, `Głośność` and `Filtr`, and a second button row has Pętla (cycles off, utwór,
kolejka and names the current mode) and Losowo (shuffle), checked against the bot's channel like the other
buttons.

Filters are applied by the adapter. It writes the client's filter data directly (timescale, rotation and
the equalizer bands) and sends it in one player update (`applyPlayerFilters`); Lavalink replaces all filters
with what an update carries, so the previous effect goes away in the same request. The client's `toggle*`
helpers are not used: they flip state, so a repeated or interrupted change could switch an effect off.
Bassboost is the `BassboostMedium` equalizer preset, nightcore and vaporwave are the client's timescale
presets, 8d is rotation at 0.2 Hz. The active name is kept per guild and forgotten with the player; it reads
"off" while an update is in flight, so a refused update never leaves a footer naming an effect that is not
on. A restarted node starts its sessions without filters, so recovery sends the effect again (a refusal
there drops it, and the music goes on).

`/back` uses the client's own previous-track history (25 tracks). With the track loop every repeat adds the
current track to that history, so `/back` passes over those copies and plays the track before them. With the
queue loop the back track already waits at the end of the queue; that copy is removed, so the loop does not
play it twice per turn.

Idle: the bot leaves 3 minutes after the queue ran out or the last person (bots do not count) left its
channel. The check runs on `trackStart`, `queueEnd`, after tracks are added and on `voiceStateUpdate`
(`alwaysRun`, so it works where the module is switched off); a track or a person coming back cancels it.

Adapter (`apps/bot/src/music`, `lavalink-client` 2.11.0): one node from `LAVALINK_URL` /
`LAVALINK_PASSWORD` (`https` means TLS), `autoSkip` on, players join self-deafened. The node is retried
forever: 20 times 3 s apart, then every 30 s, back to 3 s once it connects. The client is given an
unreachable `retryAmount` because on running out it destroys the node and every player; the delay is
changed on its `reconnecting` event instead. Music answers "niedostępny" meanwhile and comes back by
itself.
Searched tracks are cached (2000) so enqueueing needs no extra request; an older one is decoded by the
node. A malformed `/loadtracks` answer becomes an error result. Discord voice events reach the client
through the `raw` gateway event. A disconnect by someone else destroys the player. A destroy that fails on
the node (it is down) still finishes locally: the client has already left voice and dropped the player, so
the adapter emits `playerDestroyed` itself, and leaves through the gateway when the client got no further.
When the node restarts, every player leaves and rejoins its channel, because the old voice session is gone
and Discord refuses it (4006); a player with a current track then replays it from the position it had when
the node went away, or plays the next one when that position is past the track's end (the queue ends
when nothing is next). A player that cannot be brought back is destroyed. Shutdown removes the panels (module `dispose`), then
destroys the players and the node connection before the Discord client.

### Riot stats

`modules/riot` has `/valorant <riot_id>` and `/lol <riot_id> [region]`, both usable everywhere like `/help`.
The module talks to a `RiotStats` port (`valorant(id)`, `lol(id, platform)`) and a small
`KeyValueStore` slice; `apps/bot/src/riot/` implements the port (clients: ADR 8). Each game has its own key
(`RIOT_VALORANT_API_KEY`, `RIOT_LOL_API_KEY`); the port omits a game without its key and that command answers that
stats are off.

- **Input.** `Name#TAG` is split on the last `#`: name 3 to 16 characters, tag 3 to 5 letters or digits.
  `/valorant` takes the rest of the line, so the name may hold spaces; `/lol` quotes such a name in the
  prefix form (`!lol "Nazwa ze spacją#TAG" euw`). Every path segment sent to Riot goes through
  `encodeURIComponent`, and names from Riot are markdown-escaped before they reach an embed.
- **Routing.** Account-v1 always uses `europe`, which serves every Riot account. The Valorant shard comes
  from `active-shards`; the League platform is the `region` option (`eun1` by default).
- **Cache.** Only the projection the bot uses (validated fields, the newest five matches, Polish names) lives
  in Redis for the TTLs below, never a raw response. A cache that fails or holds an entry that no longer
  parses only costs a request. Redis runs with `--maxmemory 256mb --maxmemory-policy volatile-lru` (see
  "Redis eviction" below): it holds only state that can be lost (ADR 3), so evicting a cache entry is always
  safe.

  | Data                                           | TTL   |
  | ---------------------------------------------- | ----- |
  | Account, Valorant active shard                 | 1 h   |
  | Valorant match, content, Data Dragon           | 24 h  |
  | Valorant matchlist, summoner, entries, mastery | 5 min |

- **Rate limits.** A budget of 30 lookups per minute for all users together (`riot:global`, a fixed window)
  answers "za chwilę" when spent. A per-user cooldown (`riot:user:<id>`, 10 s) comes after the shared pause check, so a
  blocked user does not use it up. A 429 stores the deadline `now + Retry-After` (10 s without the header or with a zero one, at most 120 s)
  as the value of `riot:retry-after:<game>`, with the same duration as its TTL; Riot limits each key on its own,
  so the pause covers only that game, and until it ends that game's lookups answer "Spróbuj za N s" without
  calling Riot.
- **Errors.** 404 is "not found", 401 and 403 are "the key has no access", 429 is the pause above, and
  timeouts, 5xx and malformed answers are "Riot does not respond". A development key gets a 403 on
  `val/match/v1`, so `/valorant` with one answers that match history needs a production key; `/lol` says the
  key expired or has no access. One Valorant match that fails or has an unexpected shape is dropped from the
  list instead of failing the command.
- **Valorant profile.** The five newest matches, each with result, map, agent and K/D/A; the rank is the tier of
  the newest competitive match among them. A player with no matches gets "Brak ostatnich meczów."

## Testing

- `core` and modules: unit tests with `createFakeContext`, no Discord connection.
- `db`: integration tests against a real Postgres (`TEST_DATABASE_URL`), each run in a fresh schema.
- `kv`: one contract suite for every adapter; the Redis run needs `TEST_REDIS_URL`.
- CI provides both services, so nothing is skipped there.

## Redis eviction

Redis runs with `--maxmemory 256mb --maxmemory-policy volatile-lru`: under memory pressure it evicts only
keys that have a TTL, least recently used first. Every key the bot writes carries one (caches, cooldown
and rate-limit windows, locks, component state), so nothing is kept forever; a key without a TTL would
never be evicted and could fill the memory. Locks and counters have short TTLs, so they can still be
evicted in a real shortage, which only means a duplicate or a missed limit once (ADR 3). The store the bot hands to
every module and handler is wrapped once (`createTimedStore`): a call that waits on Redis longer than 500 ms is
abandoned and rejects like a failed Redis, so each caller's existing choice applies. Rate limits and cooldowns
fail open (the command runs). Per area:

- Party: a join lock fails open because the unique owner row still stops duplicates; a SET that timed out may
  still land, so the join asks for it to be deleted again, and a release that failed is retried once in the
  background. The button rate limits fail open, and the special invite limits fail closed with a Polish message.
- Music: the search state is needed to offer the results, so a stalled store fails the `/search` with the
  generic Polish error, and a pick whose state cannot be read fails the same way.
- Dzajco: the settings cache falls back to nothing, and any Redis error skips the gif (fail closed, no
  message, as it is an event) so an outage cannot bypass the cooldown.
- Messages: the failure counter fails open to "first failure", so the send is retried the next minute.
- Moderation: the warning DM limit fails open, so the DM is sent.
- Riot: the pause read, the user cooldown, the shared budget and the pause write all fail open; the lookup
  goes ahead and the failure is logged.
- Module gate: cache reads and writes fail open to Postgres, and a lookup that fails or times out counts the
  module as enabled.

The guild setting cache also fills and refreshes with that limit, and its backfill does not delay the answer.
The module gate's 1.5 s race and the health probes use the same `withTimeout` helper; `ping` keeps its own
timeout.
