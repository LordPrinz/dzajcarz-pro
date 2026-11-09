# 4. Lavalink for audio

- **Status:** accepted
- **Date:** 2026-11-06, amended 2026-11-08 (DZAJ-50, DZAJ-13)

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

## YouTube setup (DZAJ-50)

By November 2026 the released stack (Lavalink 4.2.2, youtube-plugin 1.18.2, both the latest releases)
played almost nothing. The plugin could no longer find the signature function in YouTube's player script,
and the clients that do not need it were refused. Three changes fixed it.

**A remote cipher server.** Signature deciphering moved out of the plugin; upstream expects a remote
cipher server now. The `yt-cipher` compose service runs [kikkia/yt-cipher](https://github.com/kikkia/yt-cipher)
and Lavalink calls it at `http://yt-cipher:8001` (`plugins.youtube.remoteCipher`). We host it ourselves
instead of using the author's public instance, so playback does not depend on a third party's uptime or
rate limit. The container has no published port, runs as uid 65532 with a read-only root filesystem, no
capabilities and `no-new-privileges`. Its only writable paths are tmpfs mounts: the player script cache in
`/home/nonroot/.cache` (yt-cipher writes to `~/.cache/yt-cipher/player_cache`, not `/app/player_cache`)
and `/tmp`. The cache is rebuilt after a restart. `OVERRIDE_PLAYER_VARIANT=IAS` follows upstream's
advice that only the IAS player variant deciphers reliably.

yt-cipher only publishes a moving `master` tag, so the image is pinned by digest. To update it, read the
commits since the pinned one, then take the new index digest:

```bash
docker buildx imagetools inspect ghcr.io/kikkia/yt-cipher:master   # "Digest: sha256:…"
```

Put that digest in `infra/docker-compose.yml` and recreate the `yt-cipher` and `lavalink` services.

**A youtube-plugin snapshot.** With the cipher working, every client in 1.18.2 still failed. Only the
IOS client update on youtube-source `main` (not in a release yet) plays, so the plugin is pinned to the
snapshot of commit `2be8e542d3f6f178e048dca565892684c2e40177` (`snapshot: true`, from
`maven.lavalink.dev/snapshots`). Lavalink downloads it on start and deletes the old jar from the plugins
volume. To move back to a release once one contains these fixes (anything newer than 1.18.2), set the
version in `infra/lavalink/application.yml`, set `snapshot: false`, recreate `lavalink`, check the log
says `Loaded 'youtube-plugin-<version>.jar'`, and run the per-client check below again.

**Clients.** Per-client results on 2026-11-08, from a home connection in Poland, snapshot plus cipher,
streamed through the plugin's `/youtube/stream/{id}?withClient=` route. Every client was tried on 4 fixed
videos (`dQw4w9WgXcQ`, `7FwDP17XPlk`, the Lato z Radiem jingle `k4FITH0BtYA`, `S7sN-cFhwuk`); the two
that played more than one of them were also tried on 14 search results. `dQw4w9WgXcQ` comes with direct
stream URLs and plays on most clients, so it proves little.

| Client           | Plays                  | Failure                                                    |
| ---------------- | ---------------------- | ---------------------------------------------------------- |
| `IOS`            | 18 of 18               | none                                                       |
| `MWEB`           | 3 of 18                | HTTP 403                                                   |
| `WEB`            | 1 of 4 (`dQw4w9WgXcQ`) | "No supported audio streams available" (SABR-only formats) |
| `ANDROID_VR`     | 1 of 4 (`dQw4w9WgXcQ`) | "This video requires login"                                |
| `TVHTML5_SIMPLY` | 1 of 4 (`dQw4w9WgXcQ`) | "Sign in to confirm you're not a bot"                      |
| `WEBEMBEDDED`    | 0 of 4                 | "This video is unavailable"                                |
| `ANDROID_MUSIC`  | 0 of 4                 | "This video requires login"                                |
| `TV`             | 0 of 4                 | "The page needs to be reloaded"                            |
| `MUSIC`          | search only            | cannot play                                                |

The configured list is `MUSIC, WEB, ANDROID_VR, IOS`: `MUSIC` for `ytmsearch:`, `WEB` for search and
video metadata, `ANDROID_VR` for playlists (WEB can no longer parse them), `IOS` for playback. `WEB` and
`ANDROID_VR` have `playback: false`, so a track goes straight to `IOS` instead of failing twice first.
`WEB` stays before `IOS` because `ytsearch:` comes back empty with `IOS` first (youtube-source #250). No
OAuth, account or poToken is used.

**What plays.** Checked in a voice channel with node-side positions, 20 seconds per track, and again
straight after recreating the Lavalink container (the node answers within about 6 seconds and the first
track starts right away):

- YouTube search (`ytsearch:`), YouTube Music search (`ytmsearch:`), video URLs and playlists: play.
- SoundCloud: does not work. Search fails with "Did not detect any supported formats"; upstream also
  reports 404s on playback (lavaplayer #189 and #203, still open; Lavaplayer 2.2.7 does not fix it).
  The only reported workaround is an unofficial fork plugin from JitPack, which we do not run. The
  source is switched off (DZAJ-54): `soundcloud: false` and `soundcloudSearchEnabled: false` in
  `application.yml`, and `/play` refuses SoundCloud links. To bring it back once Lavaplayer fixes both
  issues and a Lavalink release ships the fix: bump Lavalink, set both flags to `true`, add
  `soundcloud.com`, `m.soundcloud.com` and `on.soundcloud.com` to `LINK_HOSTS` in
  `modules/music/src/format.ts`, restore SoundCloud in `UNSUPPORTED_LINK`, the `/play` option description
  and `docs/DESIGN.md`, verify `scsearch:` and a track URL against the node, then recreate the Lavalink
  container.
- Vimeo: does not work. Loading succeeds, playback fails inside the Lavaplayer bundled with Lavalink
  4.2.2, the latest release.

## Local files (DZAJ-13)

The scheduled songs ("Lato z Radiem", `icona_pop`) are mp3 files in `infra/lavalink/music`, mounted read-only
at `/opt/Lavalink/music` in the Lavalink container, and `lavalink.server.sources.local` is on. That source
loads any path the node can read, so it is only safe while no member can choose the path:

- `/play` and `/search` turn everything a member types into a `ytsearch:` query or one of the allowed
  links (`parseQuery`, `toIdentifier`). `local:/etc/passwd` and `/etc/passwd` become search words, and tests
  in `mapping.test.ts` and `lavalink.test.ts` assert the identifiers the node receives.
- Only the schedule module reaches `playLocalFile`, through a name from a list in the code. The adapter looks
  the name up and refuses an unknown one, so the path is never built from input. `playLocalFile` also checks
  the path itself: it must lie in `/opt/Lavalink/music` and the file name must match `[a-z0-9_]+\.mp3`.
- The identifier is the bare absolute path. Lavaplayer's local source opens `new File(identifier)` and has
  no prefix of its own; `local:` would become part of the file name.
- Tracks are queued from encoded ids, and those can come back from component state. The adapter refuses a
  decoded track whose source is `local`, so only `playLocalFile` ever plays a file.

What the source can reach is limited. It runs media detection on the path and reports whether it exists and
what it holds as audio; it never returns a file's contents. `application.yml` holds no secret either: the
node password comes from `LAVALINK_SERVER_PASSWORD`. The node listens on `127.0.0.1:2333` only and needs
that password. The checks above are still the hard rule, because a member who could choose a path could
probe which files exist in the container.

The `http` source stays off. It would let the node fetch any URL a track names, and anyone who can make it
load a URL could reach internal services through it (cloud metadata, Redis): server-side request forgery
with the node as the proxy. The local source can only reach the container's own files, and the bot never
lets a member pick one, so it is the smaller risk for the same feature. Adding a song means adding the file,
and a line in `scheduled-songs.ts`; the directory is mounted, so Lavalink needs no restart for a new file.

## Consequences

- Fixing YouTube breakage means changing `infra/` (plugin version, client list, yt-cipher digest), not
  releasing the bot. When playback breaks again, rerun the per-client check before changing the list.
- The plugin is a snapshot, not a release: it gets no release notes and may disappear from the snapshot
  repository. Move back to a release as soon as one has the IOS fixes.
- Production needs two more services: Lavalink with roughly 512 MB of heap, and yt-cipher.
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
  Every player is rejoined, not only those with a track, and the stored position is checked against the
  track's length: one that would have ended during the outage moves on to the next track. When the replay
  fails the player is destroyed instead of being left silent in the channel.
- **The client gives up and destroys the players.** After `retryAmount` failed reconnects
  `lavalink-client` destroys the node and every player on it. The adapter sets an unreachable
  `retryAmount` and changes `retryDelay` on the `reconnecting` event: 20 attempts 3 s apart, then one every
  30 s until the node is back, then 3 s again. Music commands say the player is unavailable meanwhile and
  work again without a restart of the bot (checked against a closed port: attempt 21 came 30 s after 20).
- **`Player#destroy` during an outage.** It leaves voice and removes the player from the manager before it
  calls the node; when that call fails it rejects and never emits `playerDestroy`. The adapter catches it
  and emits `playerDestroyed` itself, so `/stop` and the idle leave still work while the node is down.
- **`shoukaku` reconnect bug.** After a restart the node reconnected at the socket level, but the library
  marked it disconnected and every call failed with `Session not found`. In `Node#connect` the stored
  `connectError` from a failed first attempt is not cleared when a later attempt succeeds, so a successful
  retry is treated as a failure. Reproduced twice on Bun; not checked on Node.
- **`moonlink.js` session resume.** With `resume: true` every `PATCH /v4/sessions/<id>` returned 400 and was
  retried four times, and the player recovery after the restart ended in a `trackException`.
- **SoundCloud search fails on the node, not in the clients.** `scsearch:` returns `loadType: error`
  ("Did not detect any supported formats", Lavaplayer 2.2.6) from plain REST too, for several queries and a
  direct track URL. YouTube is unaffected. SoundCloud has since been switched off (DZAJ-54, see above).
- **YouTube plugin 1.18.2 works** with the configured clients (`MUSIC`, `WEB`, `ANDROID_VR`,
  `TVHTML5EMBEDDED`): search, URL, playlist and playback all succeeded, no login or OAuth needed so far.
  Breakage is expected over time; the fix is a plugin bump in `application.yml`.
- `lavalink-client` needs `autoReconnect` and `retryAmount` set on the node to ride out a restart; the spike
  used `retryAmount: 20`, `retryDelay: 3000`.
