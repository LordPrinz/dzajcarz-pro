-- Party areas set up through a form: each area names its members' channels from a template ({user} is
-- replaced by the member's display name) and remembers whether it wants a command channel.
-- Existing areas get the defaults, so they keep working.
ALTER TABLE party_area
  ADD COLUMN name_template    text    NOT NULL DEFAULT '🎉 {user}',
  ADD COLUMN command_channel  boolean NOT NULL DEFAULT false;
