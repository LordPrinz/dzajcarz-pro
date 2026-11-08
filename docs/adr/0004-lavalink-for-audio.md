# 4. Lavalink for audio

- **Status:** accepted
- **Date:** 2026-11-06, amended 2026-11-08 (DZAJ-50)

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
  source stays enabled so it starts working again with a fixed Lavalink release.
- Vimeo: does not work. Loading succeeds, playback fails inside the Lavaplayer bundled with Lavalink
  4.2.2, the latest release.

## Consequences

- Fixing YouTube breakage means changing `infra/` (plugin version, client list, yt-cipher digest), not
  releasing the bot. When playback breaks again, rerun the per-client check before changing the list.
- The plugin is a snapshot, not a release: it gets no release notes and may disappear from the snapshot
  repository. Move back to a release as soon as one has the IOS fixes.
- Production needs two more services: Lavalink with roughly 512 MB of heap, and yt-cipher.
- Without a reachable node, music commands answer with an error; everything else keeps working.
