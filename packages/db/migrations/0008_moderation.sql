-- Moderation history: every ban, kick, timeout, lifted timeout, warning and purge, with who did it and why.
CREATE TABLE moderation_action (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id      text NOT NULL,
  action        text NOT NULL CHECK (action IN ('ban', 'kick', 'timeout', 'untimeout', 'warn', 'purge')),
  moderator_id  text NOT NULL,
  -- The member acted on; a purge has none.
  target_id     text,
  -- Purge only: where the messages were deleted.
  channel_id    text,
  -- Discord's audit log limit.
  reason        text CHECK (char_length(reason) <= 512),
  -- Timeout only.
  duration_ms   bigint CHECK (duration_ms > 0),
  -- Purge only: how many messages were deleted.
  message_count integer CHECK (message_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'purge') = (target_id IS NULL)),
  CHECK ((action = 'purge') = (channel_id IS NOT NULL)),
  CHECK ((action = 'purge') = (message_count IS NOT NULL)),
  CHECK ((action = 'timeout') = (duration_ms IS NOT NULL))
);

-- /warnings: a member's warnings in a guild, newest first.
CREATE INDEX moderation_action_target_idx
  ON moderation_action (guild_id, target_id, action, created_at DESC);
