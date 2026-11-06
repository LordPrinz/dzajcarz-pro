-- Party areas: a join channel in a category. Joining it makes a voice channel for the member.
-- Deleting an area removes its party channels' rows too.
CREATE TABLE party_area (
  join_channel_id text PRIMARY KEY,
  guild_id        text NOT NULL,
  category_id     text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite foreign key below.
  UNIQUE (join_channel_id, guild_id)
);

CREATE INDEX party_area_guild_id_idx ON party_area (guild_id);

-- UNIQUE (guild_id, owner_id): a member owns one party channel per guild at a time, even if two
-- joins race past the Redis lock. The composite foreign key keeps a channel's guild equal to its area's.
CREATE TABLE party_channel (
  channel_id           text PRIMARY KEY,
  guild_id             text NOT NULL,
  owner_id             text NOT NULL,
  area_join_channel_id text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, owner_id),
  FOREIGN KEY (area_join_channel_id, guild_id)
    REFERENCES party_area (join_channel_id, guild_id) ON DELETE CASCADE
);

CREATE INDEX party_channel_area_idx ON party_channel (area_join_channel_id);
