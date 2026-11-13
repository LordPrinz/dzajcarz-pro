# 1. Monorepo on Bun workspaces

- **Status:** accepted. The branch layout in Context is history: v5 now lives on `main` on top of the joined
  v3 and v4 history, and the old branches are deleted.
- **Date:** 2026-11-06

## Context

The old bot (v3 on `main`, v4 on `dzajcarzv4`) is one `src/` tree where commands, Discord plumbing,
database access and an Express API import each other freely. Adding a feature meant touching shared files,
and nothing could be tested without a Discord connection. v5 is a rewrite, kept on an orphan branch so the
old history stays readable but does not constrain the new layout.

## Decision

One repository with Bun workspaces: `apps/bot`, `packages/{core,db,kv}` and `modules/*`, one workspace per
feature. Bun is the package manager, test runner and runtime.

## Consequences

- A module's dependencies are visible in its `package.json`; a module importing another module shows up
  in review.
- One CI pipeline and one set of conventions for everything.
- No Turborepo: `bun run --filter` is enough at this size.
