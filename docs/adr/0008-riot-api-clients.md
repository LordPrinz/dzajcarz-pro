# 8. Riot API clients: a wrapper for Valorant, plain fetch for League

- **Status:** accepted
- **Date:** 2026-11-09

## Context

`/valorant` and `/lol` read player stats from the Riot Games API. ADR 2 prefers Bun built-ins and allows a
library where Bun has nothing. Bun has no Riot client, so the question is which calls go through a library.

## Decision

- Valorant goes through [`wrapper-valorant-api`](https://www.npmjs.com/package/wrapper-valorant-api) 3.0.1,
  the owner's package: no runtime dependencies, typed DTOs and errors, a `CacheAdapter`, `AbortSignal`
  timeouts, ESM. The bot validates every response with its own zod schemas, because wire data is untrusted,
  and caches the validated projection in its `KeyValueStore` itself rather than through the wrapper's cache,
  which would store whole responses.
- League goes through plain `fetch`. Only four Riot endpoints plus Data Dragon are used, and no comparable
  zero-dependency League client exists, so a library would add more than the calls it saves.
- Both sit behind the `RiotStats` port of `modules/riot`. Only `apps/bot` imports the wrapper, so the
  module and its tests never see it, and either client can be replaced without touching the commands.
- The version is pinned exactly, as every dependency is (`bunfig.toml`).

## Consequences

- One more runtime dependency, with a single maintainer who is also the bot's owner.
- A Riot development key expires every 24 hours and has low rate limits. It also gets a 403 from
  `val/match/v1`, so Valorant match history needs a production key. The bot reports that as a Polish error
  instead of a failure.
- The two clients share `errors.ts` (status and `Retry-After` mapping, the timeout) and the read and write
  helpers behind `createCachedJson` in `cache.ts`. The request code, zod schemas and profile mapping are
  written twice, once per client.
