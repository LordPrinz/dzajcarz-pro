#!/bin/sh
# Puts the YouTube plugin into the plugins volume before Lavalink starts, verified against the hash in
# youtube-plugin.sha256. Lavalink skips its own download when a jar of the configured version is already
# there, so it only ever loads a jar that passed this check (ADR 0004).
set -eu

PLUGINS=/opt/Lavalink/plugins
CHECKSUM_FILE=/youtube-plugin.sha256
REPOSITORY=https://maven.lavalink.dev/snapshots/dev/lavalink/youtube/youtube-plugin

jar=$(awk '{ print $2 }' "$CHECKSUM_FILE")
version=${jar#youtube-plugin-}
version=${version%.jar}
cd "$PLUGINS"
# After the first run the volume belongs to Lavalink's uid; take it back so root can write without
# CAP_DAC_OVERRIDE (production drops it).
chown 0 "$PLUGINS"

if [ -f "$jar" ] && sha256sum -c -s "$CHECKSUM_FILE"; then
  echo "youtube-plugin $version already verified"
else
  rm -f "$jar.part"
  wget -q -O "$jar.part" "$REPOSITORY/$version/$jar"
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

# A jar left over from an older version would be deleted by Lavalink anyway; doing it here keeps the
# volume holding only what was checked.
for old in youtube-plugin-*.jar; do
  [ "$old" = "$jar" ] || rm -f "$old"
done
chown -R 322 "$PLUGINS"
