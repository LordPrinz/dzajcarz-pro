-- One row per guild that changed a setting; guilds without a row use the defaults.
CREATE TABLE guild_settings (
  -- Discord snowflake. Stored as text: it does not fit a JavaScript number.
  guild_id   text PRIMARY KEY,
  prefix     text CHECK (prefix IS NULL OR char_length(prefix) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
