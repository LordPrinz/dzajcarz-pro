-- The language the bot speaks on a server (/language set); NULL uses the bot's default (Polish).
ALTER TABLE guild_settings
  ADD COLUMN locale text CHECK (locale IS NULL OR locale IN ('pl', 'en', 'de'));

-- A member's own language for direct messages with the bot. A member without a row gets their Discord
-- client's language when the bot speaks it, else the default.
CREATE TABLE user_settings (
  -- Discord snowflake, as text like every other id.
  user_id    text PRIMARY KEY,
  locale     text CHECK (locale IS NULL OR locale IN ('pl', 'en', 'de')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
