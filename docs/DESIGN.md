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
which keeps both forms unambiguous. An option with `prefixOnly: true` is left out of the slash command, for
when slash collects that input another way (a modal); `run` then branches on `ctx.canShowModal`. See ADR 5.

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
an expired one answers "To menu wygasło". The state store (`createComponentStateStore`) is available in
core but not wired into the composition root: the first module that needs it creates one from the
`KeyValueStore` it is given. `createPaginator` renders `◀ | Strona N/M | ▶`; its `data` shares the
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
a channel's `guild_id` equal to its area's. `create`, `edit` and `delete` need Manage Channels for the caller. That check is on the subcommands, not on `/party`
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

Everything in that chat except the panel is deleted 15 seconds after it appears, the bot's replies to prefix
commands and slash replies included. A `messageCreate` handler schedules the delete through the `Scheduler`
port (`@dzajcarz/core`: `after(ms, task)`, `createScheduler()` is `setTimeout`, `createFakeScheduler()` in
`@dzajcarz/core/testing` is advanced by hand). Messages that fall due within one second of each other are
deleted in one request per channel, so a burst costs one call (the effective delay is 15 to 16 s). The flush
re-reads the area, so a message that turns out to be the panel (its creation event can beat the write of its
id) or a flag switched off meanwhile is left alone. Pinned and system messages are never scheduled; a message
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

Audio goes through Lavalink (ADR 4). `modules/music` talks to ports only, so tests run without a node and
the client library can be swapped:

- `MusicPlayer`: `available()`, `search(query, requesterId)` (tracks, a playlist, empty or an error),
  per guild `state()` (voice and text channel, current track, upcoming tracks, position, paused), `join`,
  `enqueue`, `skip(guildId, expectedTrackId)` (a no-op once that track is no longer current or was already
  skipped, so a double click skips one track), `pause`, `resume`, the controls `setLoop`, `shuffle`,
  `seek(guildId, position, expectedTrackId)`, `setVolume`, `setFilter`, `remove`/`jump` (zero-based place plus
  the id the module saw there, so a queue that moved meanwhile is left alone), `previous` (the track, `"none"`
  or `"changed"`) and `clear`, `leave` (works without a node), and `subscribe` for `trackStart`, `queueEnd`,
  `playerDestroyed` and `trackFailed`. `jump`, `previous` and `seek` also answer "changed" (false) while a
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
`music.`), youtu.be, soundcloud.com (plus `m.`, `on.`), bandcamp.com and its subdomains, twitch.tv (plus
`www.`, `m.`) or vimeo.com (plus `www.`, `player.`), compared exactly on the parsed, punycode hostname,
with no user info and no explicit port; the link then goes on in the parser's normalised form, so the node
fetches the host that was checked. Any other link is refused with "Obsługuję tylko linki z YouTube,
SoundCloud, Bandcamp, Twitch i Vimeo." Anything else is YouTube search text, sent as `ytsearch:<text>`
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
`trackStart` and edited on the next ones (and when tracks are added or playback is paused). It shows the
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
the track's length, while the end itself is allowed and simply ends the track; when another track plays by
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

## Testing

- `core` and modules: unit tests with `createFakeContext`, no Discord connection.
- `db`: integration tests against a real Postgres (`TEST_DATABASE_URL`), each run in a fresh schema.
- `kv`: one contract suite for every adapter; the Redis run needs `TEST_REDIS_URL`.
- CI provides both services, so nothing is skipped there.
