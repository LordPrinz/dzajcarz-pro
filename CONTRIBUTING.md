# Contributing

## First-time setup (repository owner)

```bash
gh auth refresh -s project   # Projects API needs the extra scope
bun run gh:setup             # repository settings, labels, rules, then the project board
```

The script prints the few steps GitHub only allows in the browser (board views, built-in workflows,
`PROJECTS_TOKEN` secret).

## Board

`Backlog → Todo → In Progress → QA → Done`

| Status      | Meaning                                 | How it gets there                        |
| ----------- | --------------------------------------- | ---------------------------------------- |
| Backlog     | Not planned yet                         | new issue (automatic)                    |
| Todo        | Planned for the current sprint          | sprint planning (manual)                 |
| In Progress | Someone is working on it                | branch `DZAJ-<n>-…` pushed (automatic)   |
| QA          | PR open: code review + test on a server | PR opened / ready for review (automatic) |
| Done        | Merged to `v5`                          | PR merged (automatic)                    |

Fields: **Area**, **Priority** (P0 blocks others · P1 this sprint · P2 nice to have), **Size** (S ≤ ½ day ·
M 1–2 days · L split it), **Sprint** (2 weeks).

Every task is a GitHub issue. Create it from the board with _+ Add item → Create new issue_, never as a
draft (drafts have no number).

## Flow

```bash
gh issue develop 12 --base v5 --name DZAJ-12-music-queue --checkout   # or "Create a branch" on the issue
# …work…
git commit -m "feat(music): Add queue command"   # hook turns it into "[DZAJ-12] feat(music): Add queue command"
git push -u origin HEAD                           # pre-push: branch name, typecheck, tests
gh pr create --base v5 --fill                     # PR title must follow the same format
```

Test new commands on a private test server: set `DISCORD_DEV_GUILD_ID`, so slash commands show up there at
once instead of after the global rollout. The bot registers them itself on start: it reads the set Discord
has and sends the new one only when it differs (the log says "Deployed slash commands" or "Slash commands
are up to date"). `COMMANDS_AUTO_DEPLOY=false` turns that off. `bun run commands:deploy` is now optional;
it does the same without starting the bot and always sends the set.

Guild commands cannot be used in DMs or as a user-installed app. To try those, deploy globally with
`DEPLOY_GLOBAL=1 bun run commands:deploy`. With a dev guild set, this also empties the dev guild so the
commands do not show up twice (the global rollout can take a while). To go back to dev-guild mode, run
`DEPLOY_CLEAR=1 bun run commands:deploy` (empties the global set), then a plain `bun run commands:deploy`.
Both flags accept `1` or `true`. The bot reads `DEPLOY_GLOBAL` too: started with it, the bot deploys the
global set and empties the dev guild instead of filling it. In dev guild mode the bot leaves the global set
alone and logs "Global commands duplicate the dev guild" when it is not empty, because the dev guild then
shows every command twice; run `DEPLOY_CLEAR=1 bun run commands:deploy` to empty it. Before unsetting
`DISCORD_DEV_GUILD_ID`, empty the dev guild (`DEPLOY_GLOBAL=1 bun run commands:deploy` does it), or its
commands stay behind next to the global ones.

## Installing the bot

In the Discord Developer Portal, open the application, then _Installation_:

- Enable both **User Install** and **Guild Install**, and use the **Discord-provided link** as the
  install link.
- Guild Install default scopes: `bot` and `applications.commands`.
- Guild Install permissions: View Channels, Send Messages, Embed Links, Read Message History, Manage
  Messages, Manage Channels, Manage Roles, Move Members, Connect, Speak, Ban Members, Kick Members,
  Moderate Members, Add Reactions.
- Privileged intents on the _Bot_ page: Message Content and Server Members.

A user install adds the bot to a person's account: `/help` and `/ping` then work in DMs, group DMs and
servers where the bot is not a member. In such servers the bot cannot post in the channel, so replies are
interaction responses only.

## Conventions

- **Trunk** is `v5`, an orphan branch. `main`, `dzajcarzv4` and `release/botv3` hold the old bot and are
  never merged into it.
- **Ticket** `DZAJ-<n>` is issue `#<n>` (autolinked on GitHub).
- **Branch:** `DZAJ-<n>-short-kebab-description`.
- **Commit / PR title:** `[DZAJ-<n>] <type>(<optional scope>): <Description>`
  - types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`
  - scopes: `core`, `bot`, `db`, `kv`, `general`, `settings`, `music`, `party`, `moderation`, `welcome`, `status`, `fun`, `infra`
  - `!` after the type/scope marks a breaking change.
- PRs are **squash-merged**; the PR title becomes the commit on `v5`.
- **Dependabot** keeps its own `dependabot/…` branches; its PRs use the umbrella ticket DZAJ-3
  (`[DZAJ-3] build(deps): Bump …`) and go through the same checks.
- Code, comments, docs and commits are in English. What the bot says on Discord is in Polish.

## Adding a feature module

1. Create `modules/<name>` with a `package.json` named `@dzajcarz/module-<name>` that depends on
   `@dzajcarz/core`.
2. Export a factory `create<Name>Module(deps)` that returns a `BotModule`. `deps` lists only the ports
   the module needs (ADR 5); the module never reads env variables or creates clients itself.
3. Define commands with `defineCommand` and event handlers with `defineEvent`. Throw `UserError` for
   anything the caller should read; other errors are logged and replaced by a generic message. Rate-limit a
   command that hits an external service or floods a channel with `cooldownMs` (per member, enforced by the
   dispatcher; a subcommand's value overrides the command's).
4. Add the module to `apps/bot/src/modules.ts` and pass its dependencies from `apps/bot/src/index.ts`.
5. Test commands with `createFakeContext` from `@dzajcarz/core/testing`, without Discord.
6. Where a command runs (optional, ADR 7): `contexts: { places, installs }` on `defineCommand`. Places are
   `guild`, `bot-dm` and `private-channel`; installs are `guild` and `user`. Without it the command is guild
   only with the guild install. `private-channel` needs the `user` install, and `permissions` needs a
   guild-only command. Never use `channel.send` for a command that can run in a DM or user install; reply
   through `ctx.reply`.
7. Buttons and select menus (optional, ADR 6): put plain-data rows in `ctx.reply({ components })`, build each
   `custom_id` with `component.customId(ctx.user.id, state)`, declare the handlers with `defineButton` /
   `defineSelect` and list them in `BotModule.components`. For paging use `createPaginator`; for state
   that does not fit into 100 characters use `createComponentStateStore`. Test clicks with
   `clickComponent({ registry, customId })` from `@dzajcarz/core/testing`.
8. Modals (optional, ADR 6): declare a form with `defineModal` (text, select, channel and user fields), list it in
   `BotModule.modals` and open it with `ctx.showModal(modal.build(ctx.user.id, state))` from a slash command
   or a component handler. Prefix commands cannot open one: check `ctx.canShowModal` and keep an argument
   form. `showModal` must be the first answer (no `defer` before it, load defaults fast). The submit is
   gated separately, so a modal opened by a privileged command declares the same `permissions` /
   `guildOnly`, and `ctx.state` is untrusted. Test with `ctx.modals` and
   `submitModal({ registry, customId, values, fromMessage? })` from `@dzajcarz/core/testing`.

## Git hooks (Husky)

| Hook                 | Runs                                           |
| -------------------- | ---------------------------------------------- |
| `prepare-commit-msg` | adds `[DZAJ-<n>]` from the branch name         |
| `commit-msg`         | validates the header format                    |
| `pre-commit`         | `biome check --staged --write` on staged files |
| `pre-push`           | branch name check, `typecheck`, `bun test`     |

CI repeats every check, so `--no-verify` only moves the failure to the PR.

## Definition of done

- Acceptance criteria in the issue are met.
- Tests cover the change; CI is green.
- Slash commands deployed to the test server and tried in both forms (slash and prefix).
- One approving review.
- Docs and `docs/DESIGN.md` updated if a decision changed (larger decisions get an ADR in `docs/adr`).
