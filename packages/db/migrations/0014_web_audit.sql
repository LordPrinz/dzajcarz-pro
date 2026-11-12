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

-- A row is written as `pending` and gets its outcome (and error) once; after that no UPDATE changes it,
-- whoever asks. The panel cannot delete rows (no grant); the table owner still can, and can disable the
-- trigger, so this guards against the panel, not against the bot's own role.
CREATE FUNCTION web_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome <> 'pending' THEN
      RAISE EXCEPTION 'a web_audit row starts as pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome <> 'pending' THEN
    RAISE EXCEPTION 'web_audit row % is finished and cannot change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.actor, NEW.action, NEW.guild_id, NEW.channel_id, NEW.payload, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.actor, OLD.action, OLD.guild_id, OLD.channel_id, OLD.payload, OLD.created_at)
  THEN
    RAISE EXCEPTION 'only the outcome and error of a web_audit row can change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.outcome = 'pending' THEN
    RAISE EXCEPTION 'an update must give web_audit row % its outcome', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER web_audit_append_only
  BEFORE INSERT OR UPDATE ON web_audit
  FOR EACH ROW EXECUTE FUNCTION web_audit_append_only();

-- The panel's own database role (ADR 9). It is created here without a login so the grants below have a
-- target; the `web-db-role` compose step gives it a login and its password from the environment. Roles are
-- cluster-wide, so one that already exists is fine. On a managed Postgres the bot's user may lack CREATEROLE:
-- then the operator creates the role once (docs/DEPLOYMENT.md) and this only reports it.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dzajcarz_web') THEN
    RETURN;
  END IF;
  CREATE ROLE dzajcarz_web NOLOGIN;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    NULL;
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not create the role dzajcarz_web (no CREATEROLE); see docs/DEPLOYMENT.md';
END
$$;

-- Only the audit log, and of a written row only its outcome. Later panel features add their own grants. The
-- identity column needs no grant on its sequence.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dzajcarz_web') THEN
    RAISE NOTICE 'The role dzajcarz_web does not exist; grant it its rights by hand (docs/DEPLOYMENT.md)';
    RETURN;
  END IF;
  GRANT SELECT, INSERT ON web_audit TO dzajcarz_web;
  GRANT UPDATE (outcome, error) ON web_audit TO dzajcarz_web;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO dzajcarz_web', current_schema());
END
$$;
