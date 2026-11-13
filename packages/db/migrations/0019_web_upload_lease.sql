-- A send leases its files instead of holding a row lock (and a pool connection) for the whole Discord upload
-- (#147). A lease older than UPLOAD_LEASE_MINUTES is stale, so a bot that died mid-send does not lock files
-- for good. The panel's column grants (migration 0018) do not cover it.
ALTER TABLE web_upload ADD COLUMN claimed_at timestamptz;
