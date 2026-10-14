-- The two roles every later migration relies on.
--
-- rff_owner will own the tables and never logs in. rff_app is the role the API
-- connects as: it logs in and holds no attribute that skips row-level security.
-- Its password is the runner's rff.app_password setting (RFF_APP_DB_PASSWORD), so
-- the secret never appears in this file.
--
-- Roles belong to the whole cluster, not to one database, and every test run applies
-- this file to its own new database on the same server. So the file creates a role
-- only when it is missing, and then sets the attributes either way.

-- Without this lock, two runs at once race on the same pg_authid rows: CREATE ROLE
-- fails as a duplicate, and ALTER ROLE fails with "tuple concurrently updated".
-- pg_authid is shared by every database, so the lock (held until COMMIT) makes role
-- changes take turns across the cluster. Logins only read pg_authid and do not wait.
LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rff_owner') THEN
    CREATE ROLE rff_owner;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rff_app') THEN
    CREATE ROLE rff_app;
  END IF;
  IF coalesce(pg_catalog.current_setting('rff.app_password', true), '') = '' THEN
    RAISE EXCEPTION 'rff.app_password is not set; the migration runner sets it from RFF_APP_DB_PASSWORD';
  END IF;
  EXECUTE pg_catalog.format(
    'ALTER ROLE rff_app PASSWORD %L',
    pg_catalog.current_setting('rff.app_password')
  );
END
$$;

ALTER ROLE rff_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE rff_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
