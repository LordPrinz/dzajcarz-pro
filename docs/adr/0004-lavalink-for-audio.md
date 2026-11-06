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
