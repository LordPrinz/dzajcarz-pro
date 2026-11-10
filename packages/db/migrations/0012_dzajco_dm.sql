-- Dżajco also answers in DMs with the bot, where a user can set it for that conversation: guild_id is NULL
-- there. Channel ids are unique across Discord, so the channel alone keys a row.
ALTER TABLE dzajco_channel_config DROP CONSTRAINT dzajco_channel_config_pkey;
ALTER TABLE dzajco_channel_config ALTER COLUMN guild_id DROP NOT NULL;
ALTER TABLE dzajco_channel_config ADD PRIMARY KEY (channel_id);
