-- What the web panel did on someone's behalf: one row per state-changing action. The panel writes the row
-- as `pending` before the action runs and sets the outcome afterwards; an action that cannot be recorded
-- does not run.
CREATE TABLE web_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- X-authentik-username from the proxy; null when the header is missing (local run). Attribution only.
  actor      text CHECK (char_length(actor) <= 255),
  action     text NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  guild_id   text,
  channel_id text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome    text NOT NULL
    CHECK (outcome IN ('pending', 'ok', 'failed', 'unavailable', 'timeout', 'rejected')),
  error      text CHECK (char_length(error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_audit_created_idx ON web_audit (created_at DESC);

-- The panel's own database role (ADR 9). It is created here without a login so the grants below always
-- have a target; the `web-db-role` compose step gives it a login and its password from the environment.
-- Roles are cluster-wide, so this tolerates one that already exists.
DO $$
BEGIN
  CREATE ROLE dzajcarz_web NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

-- Only the audit log, and of a written row only its outcome. Later panel features add their own grants.
GRANT SELECT, INSERT ON web_audit TO dzajcarz_web;
GRANT UPDATE (outcome, error) ON web_audit TO dzajcarz_web;
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO dzajcarz_web', current_schema());
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO dzajcarz_web', pg_get_serial_sequence('web_audit', 'id'));
END
$$;
