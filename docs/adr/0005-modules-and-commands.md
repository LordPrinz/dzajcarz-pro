# 5. Feature modules and one definition per command

- **Status:** accepted
- **Date:** 2026-11-06

## Context

The bot must accept both slash commands and prefix commands. v3 relied on WOKCommands, v4 had a custom
loader that scanned folders; both mixed Discord objects into every command, so commands could only be
tested on a live server, and features reached into each other's files.

## Decision

- A feature is a `BotModule` `{ name, commands, events }`, built by a factory that receives only the ports
  it needs (`createGeneralModule({ commands, gatewayPing, prefixFor })`). `apps/bot/src/modules.ts` is the
  single list of enabled modules; `apps/bot/src/index.ts` creates the real adapters.
- A command is defined once with `defineCommand`: name, description, typed options, optional aliases,
  `guildOnly`, `permissions`, and `run(ctx)`. `ctx.args` is typed from the options.
- `createRegistry` validates every command at startup (Discord name rules, unique names and aliases across
  modules, required options before optional ones, `rest` only on the last string option) so a bad module
  fails the boot, not a user's command.
- Adapters in `apps/bot/src/discord` turn interactions and messages into `CommandContext`, and
  `toSlashCommand` turns a definition into the JSON Discord registers.
- `executeCommand` applies the shared policy: guild-only and permission checks (needed for prefix
  commands, which Discord does not gate), `UserError` shown to the caller, everything else logged.

## Subcommands

- A command has either `options` + `run` or `subcommands` (one level, no groups, 1–25 of them); the
  registry rejects both or neither. `defineSubcommand({ description, options, permissions?, run })` types
  `ctx.args` from the subcommand's own options. Aliases stay on the command.
- Slash form: each subcommand becomes a `SUB_COMMAND` option. Prefix form: the first word picks the
  subcommand (`!prefix set ?`); a missing or unknown one gets a Polish error listing the valid names.
  The chosen name reaches the handler as `ctx.subcommand`.
- `permissions` on the command become `default_member_permissions` and a runtime check. `permissions` on
  a subcommand are an extra runtime check only, since Discord cannot gate a single subcommand. The
  Administrator shortcut applies to both.
- The registry records the owning module of every command (`moduleOf`) and event handler, and `BotModule`
  has an optional `dispose()` that `apps/bot` calls on shutdown before the client is destroyed.

## Consequences

- Commands and handlers are tested with a fake context; only the thin adapters need Discord.
- Command options are limited to what both forms can express: no autocomplete or subcommand groups yet.
  When a module needs them, extend the model here instead of bypassing it.
- Removing a command requires `bun run commands:deploy`, or Discord keeps showing it (the bot logs a
  warning when such a command is used).
