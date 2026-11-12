-- The web panel's queries end after 5 s (#146): a search the archive cannot answer quickly must not hold a
-- connection and a CPU. The setting applies to new logins of dzajcarz_web. The role's owner (the bot's user,
-- which created it in 0014) may set it; without that right the migration logs a NOTICE and the operator sets
-- it by hand (docs/DEPLOYMENT.md). infra/postgres/web-role.sql sets it as well.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dzajcarz_web') THEN
    RAISE NOTICE 'The role dzajcarz_web does not exist; set its statement_timeout by hand (docs/DEPLOYMENT.md)';
    RETURN;
  END IF;
  ALTER ROLE dzajcarz_web SET statement_timeout = '5s';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not set statement_timeout for dzajcarz_web; see docs/DEPLOYMENT.md';
END
$$;
