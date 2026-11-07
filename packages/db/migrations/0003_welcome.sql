-- Per-guild welcome message: where to post it and the template with {user}-style placeholders.
-- The 2000 limit is Discord's message length, so a stored template can always be sent.
CREATE TABLE welcome_config (
  guild_id   text PRIMARY KEY,
  channel_id text NOT NULL,
  template   text NOT NULL CHECK (char_length(template) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
