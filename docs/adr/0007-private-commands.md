# 7. Commands in DMs and as a user-installed app

- **Status:** accepted
- **Date:** 2026-11-07

## Context

Discord lets an application be added to a server (guild install) or to a person's account (user install).
A user-installed app works in DMs, group DMs and in servers where it is not a member. Which of these a
slash command appears in is set by `integration_types` and `contexts` on the command. Until now every
command was registered for the guild install and only `guildOnly` decided whether prefix commands ran in a DM.

## Decision

- `defineCommand` takes `contexts: { places, installs }`. Places: `guild`, `bot-dm`, `private-channel`
  (group DMs and other DMs). Installs: `guild`, `user`. Without the field a command is guild only with the
  guild install, so a new command never leaks into DMs by accident. `guildOnly` is removed; a command is
  guild-only exactly when none of its places is outside a server. Components keep their own `guildOnly`.
- `createRegistry` rejects empty lists, unknown values, `private-channel` without the `user` install (the
  bot is never in such a channel as a member) and `permissions` on a command that runs outside servers.
- `toSlashCommand` maps the field to `integration_types` (0 guild, 1 user) and `contexts` (0 guild, 1 bot DM,
  2 private channel). `general` (`/help`, `/ping`) is available everywhere; `party`, `welcome` and `settings`
  keep the default.
- Every command and component context carries `place` (`guild`, `bot-dm` or `private-channel`, from the
  interaction's `context`; a prefix message is `guild` or `bot-dm`). Access checks and `/help` match it
  exactly, because a group DM and the DM with the bot both have no guild id. In a group DM the bot has no
  prefix, so help shows slash syntax only.
- Prefix commands in a DM use the default prefix (no guild lookup) or a mention. A command without a DM
  place answers "Ta komenda działa tylko na serwerze."; `executeCommand` makes the same check for slash.
- The module gate has nothing to switch without a guild, so DMs are never gated. Components work in DMs
  for the same reason.
- Where the bot is only user-installed (not a member of the guild) it cannot post in the channel and may
  not see it (`interaction.channel` can be null). Command and component replies go through the interaction
  (`reply`, `editReply`, `followUp`, `update`) and never `channel.send`.
- **Dev deploy:** Discord ignores `contexts` and `integration_types` on guild commands, so a deploy to
  `DISCORD_DEV_GUILD_ID` omits them. `DEPLOY_GLOBAL=1 bun run commands:deploy` deploys globally even when a
  dev guild is set, which is the only way to try DMs and the user install; it also PUTs an empty set to the
  dev guild so the commands do not show up twice. `DEPLOY_CLEAR=1 bun run commands:deploy` empties the
  global set, to return to dev-guild mode.

## Consequences

- A forgotten `contexts` makes a command invisible in DMs rather than exposed there.
- Testing private commands needs a global deploy, whose rollout can take up to an hour.
