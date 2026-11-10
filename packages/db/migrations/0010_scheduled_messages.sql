-- Scheduled messages: a server's text posted every day at a time of day, to a channel or a member's DMs.
CREATE TABLE scheduled_message (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id    text NOT NULL,
  -- HH:MM in Europe/Warsaw.
  time_of_day text NOT NULL CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1900),
  channel_id  text,
  user_id     text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Exactly one target: a channel or a member.
  CHECK ((channel_id IS NULL) <> (user_id IS NULL))
);
CREATE INDEX scheduled_message_time_idx ON scheduled_message (time_of_day);
CREATE INDEX scheduled_message_guild_idx ON scheduled_message (guild_id, time_of_day, id);

-- A member who asked not to get scheduled DMs; guild_id NULL means from every server.
CREATE TABLE scheduled_message_opt_out (
  user_id    text NOT NULL,
  guild_id   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, guild_id)
);
