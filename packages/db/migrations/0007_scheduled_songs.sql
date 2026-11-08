-- Scheduled songs ("Lato z Radiem" at 9:00 and 21:00): per-guild settings of the schedule module.
-- A guild without a row plays the default song everywhere; the module toggle switches it off.
CREATE TABLE scheduled_song_config (
  guild_id   text PRIMARY KEY,
  -- A name from the bot's fixed song list; the list lives in code, so it is not checked here.
  song       text NOT NULL CHECK (char_length(song) BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Voice channels the scheduled song never plays in.
CREATE TABLE scheduled_song_exclusion (
  guild_id   text NOT NULL,
  channel_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
