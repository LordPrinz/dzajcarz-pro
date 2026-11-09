-- Per-channel overrides of the Dżajco reply; a channel without a row uses 3% and 60 s.
CREATE TABLE dzajco_channel_config (
  guild_id         text NOT NULL,
  channel_id       text NOT NULL,
  chance_percent   smallint NOT NULL CHECK (chance_percent BETWEEN 0 AND 100),
  cooldown_seconds integer  NOT NULL CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
