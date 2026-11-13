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

### Modals

Forms use the same model and the same routing.

- `defineModal({ module, name, title, fields, permissions?, guildOnly?, run(ctx) })` declares one; the
  modal goes to `BotModule.modals`. `fields` is a record (key = field id, order = order on screen) of
  1 to 5 entries: `short` and `paragraph` text inputs (`label`, `description`, `placeholder`, `required`,
  `minLength`, `maxLength`, `defaultValue`), a `select` (string select with 1 to 25 `options` of `{ label, value, description? }`, label and value
  1 to 100 characters, values unique, optional `defaultValue` naming an option), a `channel` select (`channelTypes` filter: `text`, `voice`,
  `announcement`, `category`, `stage`, `forum`), a `user` select and a `file` upload. Selects take one value,
  except a `user` select with `minValues` / `maxValues` (0 to 25, default 1 and 1), whose value is a `string[]`
  of distinct ids when `maxValues` is above 1 (the type follows a literal `maxValues`). A `file` field is a single
  upload with optional `contentTypes` (exact types or a family such as `image/*`) and `maxBytes`; its value is
  `{ url, name, contentType, size }` taken from the attachment Discord resolved. The adapter
  (`apps/bot/src/discord/modals.ts`) wraps each field in a Discord Label component, which the installed
  discord.js 14.27 and discord-api-types support for text inputs, string, channel and user selects and file uploads. Role
  and mentionable selects, checkboxes and radio groups are not modelled yet.
- Opening: `ctx.showModal(modal.build(owner, data?, defaults?))` on slash command contexts and on component
  contexts. `build` returns a plain `ModalSpec`; `defaults` replaces `defaultValue` for one opening, `data`
  comes back as `ctx.state`. A prefix message has no interaction to answer with a modal, so
  `ctx.canShowModal` is false there and `showModal` throws a clear error; the command keeps its argument
  form and checks `canShowModal` to choose. The modal is the first answer to the interaction.
- Routing: the modal's `custom_id` is `<module>:<modal>:<owner>:<data>`, resolved with
  `registry.resolveModal`. `executeModal` applies the same gates as `executeComponent` (owner, `guildOnly`,
  `permissions`, error policy) with modal wording ("To nie Twój formularz."), and `apps/bot` checks the
  module toggle first, skipping it in a guild the bot is not in. Modals and components live in separate
  namespaces, so a button and a modal may share a name.
- Values: the payload is untrusted, so validation lives in the modal layer. The adapter
  (`readModalValues`) passes a value on only when the submitted component has the type the field declares
  (text input, channel select, user select, file upload). A channel id must be among the channels Discord resolved, of
  one of the field's `channelTypes`, and, in a guild, of that guild; a user id must be among the resolved
  users; an upload only when every submitted id has a resolved attachment. Anything else is replaced by
  `REJECTED_MODAL_VALUE`. Then `executeModal` validates against the
  definition: required fields, that a `select` value is one of its option values (a forged value gets the
  invalid-value reply; the handler's `ctx.values` is typed as the union of the option values), text length after trimming (every text value is trimmed once, so the limits
  and the handler see the same text), that select values are snowflakes, that a multi-user select has between `minValues` and `maxValues` distinct
  ids, and that a file is an https attachment of an allowed type (parameters after `;` ignored, case ignored; a
  missing type fails a type restriction) within `maxBytes`. The adapter also sends `contentTypes` as the picker's
  `file_types` filter where Discord has an equivalent (`image/*` becomes `image`, `video/*` `video`, `audio/*`
  `audio`, `application/pdf` `.pdf`; a list with any other entry sends no filter, because the filter would be
  stricter than the field). Discord has no size limit per field and the payload is untrusted, so type and size
  are checked on every submit regardless. A field definition is validated at startup: `maxBytes` a positive integer,
  `contentTypes` non-empty with well-formed `type/subtype` or `family/*` entries. A problem is an ephemeral
  reply in the submitter's language ("Pole „Temat” jest wymagane.", "Pole „Kanał” ma nieprawidłową wartość.") and the handler
  does not run. Otherwise `ctx.values` has one entry per field: a string, or `undefined` for a field with
  `required: false` left empty. Channel and user fields hold the id. The handler gets an explicit context
  (identity, `state`, `values`, `canUpdate`, `reply`, `defer`, `update`, `acknowledged`), safe to spread.
  `update` edits the message of a button or select that opened the modal; `ctx.canUpdate` tells whether
  that is the case, and `update` throws when it is not (a modal opened from a slash command).
  `defer({ ephemeral: true })` starts a private "thinking" reply even for a modal opened from a message, so a
  long handler can show progress and answer with `reply` while the clicked message stays as it is.
  A submit the handler left unanswered is closed like a click when the modal came from a message
  (`deferUpdate`, the message stays as it is); otherwise there is no message to edit, so the bot answers
  with the ephemeral "Gotowe." (no mentions) instead of leaving a "thinking" state.
- Access: the submit is a separate interaction and is gated by the modal's own `permissions` and
  `guildOnly`, not by the command or button that opened it. A modal opened by a privileged command must
  declare the same `permissions` / `guildOnly`, or anyone who obtains the `custom_id` could submit it.
  `ctx.state` comes from the `custom_id`, which the client sends back, so treat it as untrusted input and
  keep nothing in it that a handler would act on without checking (ids, roles, amounts).
- Startup checks: the registry builds every modal once with a worst-case owner id and rejects more than
  5 fields, a title over 45, a label over 45, a description or placeholder over 100, text over 4000 or
  inconsistent `minLength` / `maxLength`, a `custom_id` over 100 characters, and the same name rules as
  components.
- Testing: `ctx.modals` on the fake command and component contexts captures what was opened (and runs the
  Discord limit checks); `submitModal({ registry, customId, values })` from `@dzajcarz/core/testing` plays
  a submit through lookup, owner, permissions, validation and the error policy. `values` is what the user
  gave: text for inputs, an array of ids for selects, an array with one `ModalFile` for an upload.

### Public components and user selects

A panel posted once in a channel is pressed by many people, so a component can be declared `public: true`.
Its `custom_id` owner is `PUBLIC_OWNER` (`*`, not a snowflake) and `executeComponent` skips only the owner
check for it; `guildOnly`, `permissions` and the module toggle still apply. A component that is not public
refuses everyone for the `*` owner, so the exemption cannot be reached by crafting an id. A public handler
must act on `ctx.user`, never on the owner. Modals stay owner-bound: a public button that opens one builds it
with the presser as owner. `defineUserSelect` adds a single-choice user select in messages (`ctx.values` holds
the user id); the adapter rejects an interaction whose type does not match the component's kind.

## Consequences

- Modules stay free of discord.js at runtime and component handlers are tested with fakes.
- Message components are buttons, string selects and user selects; role, mentionable and channel selects in
  messages and the components v2 layout are added to the model when a module needs them. Modals offer text inputs, string, user and channel selects and file uploads (see above).
- Components never expire on their own. A stale click either finds expired state (the message above) or
  a handler that was removed (an ephemeral "outdated" message and a warning in the log).
- State in a `custom_id` is visible to anyone who can read the message's JSON: keep secrets out of it.
