-- Run by the `web-db-role` compose step as the database owner on every start: gives the web panel's role
-- (ADR 9) its login and sets its password from WEB_POSTGRES_PASSWORD, so a changed password takes effect on
-- the next start. What the role may touch is granted by the migrations the bot runs (0014 onwards).
\set ON_ERROR_STOP on
\getenv web_password WEB_POSTGRES_PASSWORD

-- The migration creates the role too; whichever runs first wins.
DO $$
BEGIN
  CREATE ROLE dzajcarz_web NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

ALTER ROLE dzajcarz_web WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'web_password';
-- Migration 0017 sets this too; here it also holds where the bot's user may not alter the role.
ALTER ROLE dzajcarz_web SET statement_timeout = '5s';
