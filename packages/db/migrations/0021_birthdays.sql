-- A member's birthday, without a year. It is the member's own data, shared by every server, so leaving a
-- server keeps it; /birthday remove deletes it. 29 February is allowed (it is wished on 28 February in
-- other years).
CREATE TABLE birthday (
  user_id    text PRIMARY KEY,
  month      smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  day        smallint NOT NULL CHECK (
    day >= 1 AND day <= CASE month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30
      WHEN 11 THEN 30 ELSE 31 END
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX birthday_date_idx ON birthday (month, day);

-- Where a server posts birthday wishes; the 2000 limit is Discord's message length.
CREATE TABLE birthday_config (
  guild_id   text PRIMARY KEY,
  channel_id text NOT NULL,
  template   text NOT NULL CHECK (char_length(template) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per wish sent (or being sent): a server's post (target = guild id) or the DM (target = 'dm').
-- The row is claimed before sending, so a wish goes out at most once per target and year, across restarts.
CREATE TABLE birthday_wish (
  user_id    text NOT NULL,
  target     text NOT NULL,
  year       smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target, year)
);

CREATE INDEX birthday_wish_target_idx ON birthday_wish (target);
