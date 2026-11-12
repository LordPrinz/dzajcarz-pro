-- The message archive the web panel reads (#145). Off by default: a server is archived only while its row
-- here says so, and DMs only while the switch in `archive_dm_settings` is on. Settings are written by the bot
-- on the panel's command and cached in Redis by the bot.
CREATE TABLE archive_settings (
  guild_id             text PRIMARY KEY,
  enabled              boolean NOT NULL DEFAULT false,
  -- Channels (or thread parents) of an archived server whose messages are not stored.
  excluded_channel_ids text[] NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One row at most: whether DMs with the bot are archived.
CREATE TABLE archive_dm_settings (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per message, as last seen. An edit moves the previous version to `archived_message_version`, a
-- delete sets `deleted_at` and keeps the row. No retention limit.
CREATE TABLE archived_message (
  message_id          text PRIMARY KEY,
  -- null: a DM.
  guild_id            text,
  channel_id          text NOT NULL,
  author_id           text NOT NULL,
  -- The author as they looked when the message was stored.
  author_username     text NOT NULL,
  author_display_name text,
  author_avatar_url   text,
  author_bot          boolean NOT NULL,
  content             text NOT NULL DEFAULT '',
  -- Links and metadata only; the files stay on Discord's CDN.
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  embeds              jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The message this one replies to, when it is a reply.
  reply_to_id         text,
  created_at          timestamptz NOT NULL,
  edited_at           timestamptz,
  deleted_at          timestamptz,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  -- Full-text search (#146); 'simple' because the messages mix Polish and English.
  search              tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

-- "The latest N in a channel" and "older than X" (keyset on created_at, then id).
CREATE INDEX archived_message_channel_idx
  ON archived_message (channel_id, created_at DESC, message_id DESC);
-- A server's messages by date (the panel's search filters, #146).
CREATE INDEX archived_message_guild_idx ON archived_message (guild_id, created_at DESC);
CREATE INDEX archived_message_search_idx ON archived_message USING gin (search);

-- What a message said before an edit; `edited_at` is when that version was written (null: the original).
CREATE TABLE archived_message_version (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  text NOT NULL REFERENCES archived_message (message_id) ON DELETE CASCADE,
  content     text NOT NULL,
  attachments jsonb NOT NULL,
  embeds      jsonb NOT NULL,
  edited_at   timestamptz,
  replaced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX archived_message_version_message_idx
  ON archived_message_version (message_id, replaced_at);

-- The panel reads the archive and its settings directly, so reading works while the bot is down. It never
-- writes them: settings change through the bot, which also refreshes its cache.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dzajcarz_web') THEN
    RAISE NOTICE 'The role dzajcarz_web does not exist; grant it its rights by hand (docs/DEPLOYMENT.md)';
    RETURN;
  END IF;
  GRANT SELECT ON archive_settings, archive_dm_settings, archived_message, archived_message_version
    TO dzajcarz_web;
END
$$;
