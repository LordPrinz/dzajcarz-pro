-- Files the web panel stages for a message it asks the bot to send (#147). Pub/sub carries at most 64 KB, so
-- the panel writes each file here and sends only its id; the bot reads the files and sends them. A row stays
-- until it is an hour old, also once sent: a retry of the same message (same nonce) then still finds its
-- files and Discord deduplicates it. 26214400 bytes is MAX_UPLOAD_BYTES (25 MiB).
CREATE TABLE web_upload (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  size       integer NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  data       bytea NOT NULL CHECK (octet_length(data) = size),
  -- The nonce of the message that sent the file; a send with another nonce does not get it.
  sent_nonce text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_upload_created_idx ON web_upload (created_at);

-- At most 500 MiB (524288000 bytes) of unexpired files at once, whoever inserts. The limit is a function of
-- its own, so a test can lower it inside a transaction it rolls back. The trigger is SECURITY DEFINER because
-- the panel's role may not read the table to add it up; the lock makes concurrent inserts take turns, so two
-- of them cannot both pass the check.
CREATE FUNCTION web_upload_quota_bytes() RETURNS bigint
  LANGUAGE sql IMMUTABLE AS $$ SELECT 524288000::bigint $$;

CREATE FUNCTION web_upload_quota() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  total bigint;
  quota bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('web_upload_quota'));
  EXECUTE format(
    'SELECT coalesce(sum(size), 0), %I.web_upload_quota_bytes() FROM %s
     WHERE created_at > now() - interval ''60 minutes''',
    TG_TABLE_SCHEMA,
    TG_RELID::regclass
  ) INTO total, quota;
  IF total + NEW.size > quota THEN
    RAISE EXCEPTION 'web_upload is full' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER web_upload_quota
  BEFORE INSERT ON web_upload
  FOR EACH ROW EXECUTE FUNCTION web_upload_quota();

-- The panel may only add files, without choosing their age: no SELECT (it names the id itself, so it needs no
-- RETURNING), no UPDATE, no DELETE, and no INSERT of created_at or sent_nonce. Reading and deleting is the
-- bot's.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dzajcarz_web') THEN
    RAISE NOTICE 'The role dzajcarz_web does not exist; grant it its rights by hand (docs/DEPLOYMENT.md)';
    RETURN;
  END IF;
  GRANT INSERT (id, name, size, data) ON web_upload TO dzajcarz_web;
END
$$;
