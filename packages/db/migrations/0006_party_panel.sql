-- The control panel the bot posts in an area's command channel (the text chat of its join voice channel).
-- NULL until a panel has been posted; the bot reposts it when the message is gone.
ALTER TABLE party_area
  ADD COLUMN panel_message_id text;
