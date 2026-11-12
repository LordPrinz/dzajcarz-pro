-- The panel's reading view (#146) looks up authors by id: the names of mentioned users, and the author
-- filter of the search. No new table, so no new grant for dzajcarz_web.
CREATE INDEX archived_message_author_idx ON archived_message (author_id, created_at DESC);
