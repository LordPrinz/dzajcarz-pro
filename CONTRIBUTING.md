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

Test new commands on a private test server: set `DISCORD_DEV_GUILD_ID` and run `bun run commands:deploy`,
so slash commands show up there at once instead of after the global rollout.

## Conventions

- **Trunk** is `v5`, an orphan branch. `main`, `dzajcarzv4` and `release/botv3` hold the old bot and are
  never merged into it.
- **Ticket** `DZAJ-<n>` is issue `#<n>` (autolinked on GitHub).
- **Branch:** `DZAJ-<n>-short-kebab-description`.
- **Commit / PR title:** `[DZAJ-<n>] <type>(<optional scope>): <Description>`
  - types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`
  - scopes: `core`, `bot`, `db`, `kv`, `general`, `music`, `party`, `moderation`, `welcome`, `fun`, `infra`
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
   anything the caller should read; other errors are logged and replaced by a generic message.
4. Add the module to `apps/bot/src/modules.ts` and pass its dependencies from `apps/bot/src/index.ts`.
5. Test commands with `createFakeContext` from `@dzajcarz/core/testing`, without Discord.

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
