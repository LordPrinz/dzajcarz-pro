-- Modules a guild switched off. A row with channel_id = '' turns the module off for the whole guild;
-- a row with a channel id turns it off in that channel only. The empty string stands in for "no
-- channel" so the primary key stays a plain composite key (a NULL column cannot be part of one).
CREATE TABLE module_disabled (
  guild_id   text NOT NULL,
  module     text NOT NULL CHECK (char_length(module) BETWEEN 1 AND 32),
  channel_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, module, channel_id)
);
