# 6. Message components described as data

- **Status:** accepted
- **Date:** 2026-11-07

## Context

Help pages, confirmations and menus need buttons and select menus. discord.js builders and interaction
objects would put Discord types into every module, which ADR 5 rules out, and a click arrives as an
event with nothing but a `custom_id` to say which module should handle it. Discord also lets anyone in
the channel click a button on someone else's message.

## Decision

- A module attaches **plain data** to a reply: `ctx.reply({ components: [[button, button], [select]] })`
  with `ButtonSpec`, `LinkButtonSpec` and `SelectSpec` from `@dzajcarz/core`. `apps/bot/src/discord/components.ts`
  turns them into discord.js JSON. `validateRows` checks Discord's limits (5 rows, 5 buttons, a select
  alone in its row, 100-character `custom_id`) in the adapter and in the fake contexts, so a mistake fails a test.
- Handlers are declared with `defineButton` / `defineSelect` (`module`, `name`, `run(ctx)`) and listed in
  `BotModule.components`. The registry rejects duplicate ids, names that are not lowercase letters, digits, `-` or `_`, a component whose `module` differs from its owner, and a prefix too long for the owner id.
- `custom_id` is `<module>:<component>:<owner>:<data>`. `component.customId(owner, data)` builds it and
  throws above 100 characters; `registry.resolveComponent(customId)` finds the handler. `<data>` is small
  state (a page number, a category) and is given back as `ctx.state`.
- **Ownership:** `<owner>` is the id of the member who ran the command. `executeComponent` refuses
  anyone else with the ephemeral "To nie Twoje menu." before the handler runs.
- **Same gates as commands:** `apps/bot` checks the module toggle (a disabled module answers with the
  ephemeral "module disabled" message), then `executeComponent` applies `guildOnly` / `permissions` of
  the component and the usual error policy (`UserError` shown, anything else logged).
- `ComponentContext` has `update(reply)` (edit the message the component sits on, also after a `reply`),
  `defer()` (acknowledge now, edit later), `reply(reply)` (ephemeral unless `ephemeral: false`),
  `acknowledged`, which `executeComponent` checks: a handler that answers nothing is deferred so Discord
  does not show "interaction failed". Components refuse with "To menu działa tylko na serwerze." and
  "Nie masz uprawnień do tego menu.", the clicking user, guild and channel ids, `memberPermissions`,
  `state` and, for selects, `values`. Slash and prefix replies behave the same: a prefix reply is an
  ordinary message with components and its clicks are interactions.
- **Larger state** goes through `createComponentStateStore(keyValueStore)`: `save(value)` returns a key
  for the `custom_id`, `load(key)` throws `ExpiredStateError` (a `UserError`) after the 15 minute TTL,
  which the user sees as the ephemeral "To menu wygasło. Wywołaj komendę jeszcze raz.". Redis is allowed
  to lose it (ADR 3). Keys are 22 characters (16 random bytes, base64url) and the registry's prefix limit
  leaves room for one next to the owner id. The store is available in core and is not wired into the
  composition root; the first module that needs it builds one from the `KeyValueStore` it receives.
- `createPaginator({ module, name, render })` is the ready-made pager: `first(viewer, data)` returns
  page 1, a row `◀ | Strona N/M | ▶` with the arrows disabled at the ends is appended, and `paginator.button`
  goes to `BotModule.components`. `render` runs on every click with the clicking member's permissions,
  so a page can depend on them. `permissions` and `guildOnly` can be set on the paginator and are checked
  on every click. `data` sits in the `custom_id` next to the names, the owner id and the page number
  (`MAX_CUSTOM_ID - module.length - name.length - 28` characters are left), so keep it short or pass a
  state store key.
- Testing: `createFakeComponentContext` calls a handler directly; `clickComponent({ registry, customId })`
  plays a click through lookup, ownership, permissions and the error policy.

## Consequences

- Modules stay free of discord.js at runtime and component handlers are tested with fakes.
- Only string selects and buttons exist; user/role/channel selects, modals and the components v2 layout
  are added to the model when a module needs them.
- Components never expire on their own. A stale click either finds expired state (the message above) or
  a handler that was removed (an ephemeral "outdated" message and a warning in the log).
- State in a `custom_id` is visible to anyone who can read the message's JSON: keep secrets out of it.
