#!/bin/sh
# Puts the YouTube plugin into the plugins volume before Lavalink starts, verified against the hash in
# youtube-plugin.sha256. Lavalink skips its own download when a jar of the configured version is already
# there and mounts the volume read-only, so it only ever loads a jar that passed this check (ADR 0004).
# The volume ends up owned by root and holding nothing but that jar: even a compromised Lavalink cannot
# swap it or plant another plugin for the next start.
set -eu

PLUGINS=/opt/Lavalink/plugins
CHECKSUM_FILE=/youtube-plugin.sha256
REPOSITORY=https://maven.lavalink.dev/snapshots/dev/lavalink/youtube/youtube-plugin

jar=$(awk '{ print $2 }' "$CHECKSUM_FILE")
version=${jar#youtube-plugin-}
version=${version%.jar}
cd "$PLUGINS"
# Older setups gave the volume to Lavalink's uid. Take it back and close it (the owner may chmod without
# CAP_FOWNER), so nothing but root can write here while the check runs; production drops CAP_DAC_OVERRIDE.
chown 0:0 "$PLUGINS"
chmod 0755 "$PLUGINS"

# Takes an entry Lavalink left behind back for root, level by level: without CAP_DAC_READ_SEARCH root
# cannot look into a directory Lavalink closed (mode 000) before owning and opening it. Symlinks are
# re-owned, never followed.
reclaim() {
  chown -h 0:0 "$1"
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    chmod 0700 "$1"
    for child in "$1"/* "$1"/.[!.]*; do
      [ -e "$child" ] || [ -L "$child" ] || continue
      reclaim "$child"
    done
  fi
}

# Everything except the jar goes: other plugins, symlinks, leftovers. Lavalink loads every jar it finds.
for entry in * .[!.]*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ "$entry" = "$jar" ] && [ -f "$entry" ] && [ ! -L "$entry" ] && continue
  reclaim "$entry"
  rm -rf "$entry"
done

if [ -f "$jar" ] && sha256sum -c -s "$CHECKSUM_FILE"; then
  echo "youtube-plugin $version already verified"
else
  rm -f "$jar"
  if ! wget -q -T 60 -O "$jar.part" "$REPOSITORY/$version/$jar"; then
    echo "Could not download youtube-plugin $version from $REPOSITORY" >&2
    exit 1
  fi
  sed "s/  $jar\$/  $jar.part/" "$CHECKSUM_FILE" > /tmp/part.sha256
  if ! sha256sum -c -s /tmp/part.sha256; then
    echo "youtube-plugin $version does not match youtube-plugin.sha256; refusing to start Lavalink" >&2
    sha256sum "$jar.part" >&2
    rm -f "$jar.part"
    exit 1
  fi
  mv "$jar.part" "$jar"
  echo "youtube-plugin $version downloaded and verified"
fi

chown 0:0 "$jar"
chmod 0444 "$jar"
