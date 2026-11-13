# 11. Languages

- **Status:** accepted
- **Date:** 2026-11-13

## Context

The bot was written for a Polish group and every text was Polish. Servers and members outside it want
English or German (#155). Texts are spread over core, apps/bot and every module, and modules may not import
each other (ADR 5), so a shared translation file would couple them.

## Decision

- The bot speaks `pl`, `en` and `de`; Polish is the default (`packages/core/src/i18n.ts`).
- Each module keeps its texts in its own typed catalog (`defineMessages({ pl, en, de })`). Polish defines the
  keys and arguments; a missing or extra key in another language fails the typecheck. No i18n library: a
  catalog is a plain object of strings and functions.
- Every context carries `ctx.locale`. On a server it is the server's language; elsewhere the member's own
  choice, then their Discord client's language when the bot speaks it, then Polish. A server the bot is
  not in (user install) counts as elsewhere.
- Text sent outside a command (events, cron jobs, DMs the bot starts) asks the `LocaleResolver` port.
- Discord metadata (descriptions, choice names, modal texts) is `Localized`: one string, or one per
  language. Deploy sends Polish as the base and `*_localizations` for `en-US`, `en-GB` and `de`. Command
  names are never translated, so the prefix form and help stay the same everywhere.
- `UserError` takes a function of the locale; the dispatcher renders it for the caller.
- The choice lives in Postgres (`guild_settings.locale`, `user_settings.locale`) and is cached in Redis
  like the prefix. `/language` sets it.

## Consequences

- Adding a language means a new `Locale`, a column of every catalog, and its Discord locale codes; the
  typecheck lists every catalog that misses it.
- A prefix command accepts a choice by its value, its name in any language or an alias, so members can
  type in their own language whatever the server's.
- Polish texts stayed as they were, so existing tests still pin them.
- A DM the bot starts uses the member's saved choice only: the client language is known only while the
  member is interacting.
