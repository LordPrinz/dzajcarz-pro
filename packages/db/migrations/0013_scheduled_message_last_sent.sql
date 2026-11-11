-- The local date (in the server's zone) a scheduled message was last taken for sending. due() sends a message
-- once its time has passed on a date later than this one.
ALTER TABLE scheduled_message ADD COLUMN last_sent_date date;

-- Messages whose time has already passed today were sent under the old Redis lock; starting them empty would
-- send them again on the first tick. The zone is the server's, else Europe/Warsaw (the bot's default).
UPDATE scheduled_message m
SET last_sent_date = (now() AT TIME ZONE z.zone)::date
FROM (
  SELECT s.id, coalesce(g.time_zone, 'Europe/Warsaw') AS zone
  FROM scheduled_message s
  LEFT JOIN guild_settings g ON g.guild_id = s.guild_id
) z
WHERE z.id = m.id
  AND to_char(now() AT TIME ZONE z.zone, 'HH24:MI') >= m.time_of_day;
