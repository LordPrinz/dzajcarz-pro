# 4. Lavalink for audio

- **Status:** accepted
- **Date:** 2026-11-06

## Context

The old bot played YouTube through `discord-player`, `ytdl-core` and `@discordjs/voice` inside the bot
process. That needs native opus and sodium bindings, breaks whenever YouTube changes its player, and
spends the bot's CPU on transcoding. Native voice bindings on Bun are less proven than on Node.

## Decision

- Audio runs on a Lavalink 4 node (Java, Docker image `ghcr.io/lavalink-devs/lavalink`) with the
  `youtube-plugin` source. The bot only sends voice state to Discord and commands to Lavalink.
- The music module depends on a `MusicPlayer` port (search, play, pause, skip, queue, …). The adapter
  around the Lavalink client library lives in the module's adapter folder and is created in `apps/bot`.
  The library is chosen in a spike issue before the module is built.
- Lavalink runs under the Docker Compose profile `music`, so the rest of the bot can be developed without
  Java.

## Consequences

- Fixing YouTube breakage means bumping the plugin version in `infra/lavalink/application.yml`, not
  releasing the bot.
- Production needs one more service with roughly 512 MB of heap.
- Without a reachable node, music commands answer with an error; everything else keeps working.

## Client library

- **Choice:** `lavalink-client` 2.11.0 (spike DZAJ-10, 2026-11-08), a dependency of `apps/bot` since the
  music player (DZAJ-11).
- **Candidates:** `shoukaku` 4.3.0 and `moonlink.js` 5.2.0 were run against the same node (Lavalink 4.2.2,
  youtube-plugin 1.18.2, Bun 1.4.4, discord.js 14.27.0) with the same script: connect, join voice, search,
  play, pause, resume, seek, volume, a timescale filter, skip, restart of the Lavalink container during
  playback, clean shutdown.

|                            | lavalink-client 2.11.0                          | shoukaku 4.3.0                   | moonlink.js 5.2.0                                     |
| -------------------------- | ----------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| Last release               | 2026-08-21                                      | 2026-02-28                       | 2026-02-28                                            |
| Runtime deps / size        | ws, tslib / 1.4 MB                              | ws / 0.4 MB                      | none (own socket) / 0.6 MB                            |
| Declared engines           | node 18, bun 1.1.27                             | node 18                          | node 22                                               |
| Typings                    | Full TypeScript, events typed                   | Full, minimal surface            | `.d.ts` with `any` on `search()` and `nodes`          |
| Queue, skip, loop, filters | Built in                                        | None, the adapter owns the queue | Built in                                              |
| Runs on Bun                | Yes                                             | Yes                              | Yes                                                   |
| Node restart               | Reconnected in about 6 s                        | Did not reconnect (see below)    | Reconnected in about 8 s, tried to recover the player |
| Player state after restart | Stale: `playing` false, position keeps counting | Stale                            | Recovery started, then the track failed               |

What worked on all three: REST and websocket connection, voice state forwarding through the discord.js
`raw` event, `ytsearch:` (20 results in 0.4-0.9 s), a YouTube URL (0.1-0.4 s), a YouTube playlist of 120
tracks (1.2-1.5 s), playback with advancing position, pause, resume, seek to 0:30, volume, timescale
(nightcore) filter, stop, and a clean leave. Bun needed no workaround for `ws`, timers or ESM/CJS.

Why `lavalink-client`: it is the only candidate with a maintained release cadence in the last six months,
it ships the per-guild queue, `autoSkip`, filters and typed `trackStart`, `trackEnd`, `queueEnd`,
`playerDisconnect` and node events, so the `MusicPlayer` adapter stays thin. `shoukaku` has no queue and
its reconnect did not work; `moonlink.js` has weak typings, a noisy resume failure and a node 22 engine
requirement.

Caveats for the music ticket:

- **Node restart loses playback in every library.** A restarted Lavalink forgets its sessions, so the
  adapter has to re-send the current track at the stored position after the `connect` event; do not rely on
  the client's `resume` option, which only covers websocket drops while the node stays alive. With
  `lavalink-client` the player object survived the restart but reported `playing: false` and a position
  that kept counting. Re-sending the track is not enough on its own: the voice session died with the old
  node and Discord closes a reused one with code 4006, so the adapter leaves and rejoins the channel to get
  new voice credentials first (found while building DZAJ-11).
- **`shoukaku` reconnect bug.** After a restart the node reconnected at the socket level, but the library
  marked it disconnected and every call failed with `Session not found`. In `Node#connect` the stored
  `connectError` from a failed first attempt is not cleared when a later attempt succeeds, so a successful
  retry is treated as a failure. Reproduced twice on Bun; not checked on Node.
- **`moonlink.js` session resume.** With `resume: true` every `PATCH /v4/sessions/<id>` returned 400 and was
  retried four times, and the player recovery after the restart ended in a `trackException`.
- **SoundCloud search fails on the node, not in the clients.** `scsearch:` returns `loadType: error`
  ("Did not detect any supported formats", Lavaplayer 2.2.6) from plain REST too, for several queries and a
  direct track URL. YouTube is unaffected. SoundCloud stays enabled in `application.yml` but should not be
  advertised until a Lavalink bump fixes it.
- **YouTube plugin 1.18.2 works** with the configured clients (`MUSIC`, `WEB`, `ANDROID_VR`,
  `TVHTML5EMBEDDED`): search, URL, playlist and playback all succeeded, no login or OAuth needed so far.
  Breakage is expected over time; the fix is a plugin bump in `application.yml`.
- `lavalink-client` needs `autoReconnect` and `retryAmount` set on the node to ride out a restart; the spike
  used `retryAmount: 20`, `retryDelay: 3000`.
