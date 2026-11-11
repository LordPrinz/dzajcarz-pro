# 10. Mentions from the web panel

- **Status:** accepted
- **Date:** 2026-11-11

## Context

All bot output uses `allowedMentions: { parse: [] }` (`NO_MENTIONS`), so nothing the bot says pings anyone.
The web panel (ADR 9, #147) lets the owner write as the bot, and sometimes the point of a message is to
ping a person or a role.

## Decision

- `NO_MENTIONS` stays the default for all bot output, including panel messages.
- A panel message carries a per-message `allowMentions` toggle, off by default.
- With the toggle on, the message is sent with `allowedMentions = { parse: ["users", "roles"], repliedUser: false }`.
  `everyone` is never in `parse`, so `@everyone` and `@here` in the text are sent as plain text and cannot
  ping, whatever the toggle says.
- The toggle is part of the audit entry for the message (ADR 9, `web_audit`).
- It is enforced in two places: the protocol schema has `allowMentions: boolean` (no default on the bot
  side, so a missing value is rejected), and one adapter function in `apps/bot` turns it into the
  `allowedMentions` object. Nothing else builds `allowedMentions` for panel messages. Both land in #147.

## Alternatives considered

- **A global env flag** that allows mentions for every panel message: one forgotten setting pings people
  for good, and the owner cannot choose per message.
- **Explicit id lists** (`users: [...]`, `roles: [...]`) per message: the safest, but the panel would need
  to parse the text or ask for ids, which is more UI than the use case needs. Revisit if a leak shows up.

## Consequences

- A message that pings has to be asked for each time; the default stays quiet.
- A role ping works despite the role's "mentionable" setting only if the bot has the permission for it;
  Discord decides, not this code.
- Moderation and other modules keep `NO_MENTIONS`; this exception is for panel messages only.
