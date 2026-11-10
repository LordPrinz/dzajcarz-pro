-- A server's IANA time zone (/timezone set); NULL uses the bot's default. Scheduled messages
-- (scheduled_message.time_of_day) and scheduled songs follow it from now on.
ALTER TABLE guild_settings
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64);
