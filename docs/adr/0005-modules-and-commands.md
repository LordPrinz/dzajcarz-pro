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

## Consequences

- Commands and handlers are tested with a fake context; only the thin adapters need Discord.
- Command options are limited to what both forms can express: no subcommands or autocomplete yet. When a
  module needs them, extend the model here instead of bypassing it.
- Removing a command requires `bun run commands:deploy`, or Discord keeps showing it (the bot logs a
  warning when such a command is used).
