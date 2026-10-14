-- The tenant tables, their row-level security policies, rff_app's grants and the
-- three look-up functions that run before a request's tenant is known.
--
-- The superuser running this file creates every object and hands it to rff_owner,
-- which never logs in. rff_app owns nothing. The API reads and writes as rff_app
-- inside withTenant (apps/api/src/database/tenant-database.ts), which sets two
-- transaction-local settings:
--
--   app.tenant_id   the tenant from the route path, checked against the membership
--   app.user_id     the signed-in user, or '' for a request made with an SDK key
--
-- Every policy reads a setting as NULLIF(current_setting(name, true), '')::uuid.
-- On a connection that has never set it, current_setting returns NULL; on a pooled
-- connection reused after a transaction that set it, it returns ''. Both give NULL,
-- and no row's tenant_id equals NULL, so a query without a tenant reads nothing.
--
-- FORCE ROW LEVEL SECURITY applies the policies to the owner as well. rff_owner
-- acts only inside the three SECURITY DEFINER look-up functions at the end of this
-- file, and the policies named lookup_by_owner let those read the rows they search.

-- Since Postgres 15 PUBLIC has no CREATE on the public schema. This keeps it so on
-- a server whose defaults differ: a role that creates a table owns it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- A new database grants TEMPORARY to PUBLIC, so any role could create temporary
-- tables, views and functions. A pooled session keeps them, and its temporary schema
-- comes first when it looks up a table name. rff_app needs none.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
    pg_catalog.current_database()
  );
END
$$;

-- Declared in increasing order of rights, so viewer < editor < owner.
CREATE TYPE public.member_role AS ENUM ('viewer', 'editor', 'owner');

-- slug is unique across tenants because it names one. No API route creates a
-- tenant, so rff_app has no INSERT here.
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);

-- A user is a sign-in at an identity provider, found by (issuer, subject), so that
-- pair is unique across tenants. A user belongs to tenants through memberships.
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_issuer text NOT NULL,
  idp_subject text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  UNIQUE (idp_issuer, idp_subject)
);

CREATE TABLE public.memberships (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  role public.member_role NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_id ON public.memberships (user_id);

-- The same flag key can exist in every tenant. salt is set when the flag is created
-- and rff_app holds no UPDATE on it, so it never changes.
CREATE TABLE public.flags (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  enabled boolean NOT NULL DEFAULT false,
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{16}$'),
  rules jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rules) = 'array'),
  rollout_bp integer NOT NULL DEFAULT 0 CHECK (rollout_bp BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- key_hash is the SHA-256 of the key, 32 bytes. It is unique across tenants because
-- the key alone names its tenant.
CREATE TABLE public.sdk_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  key_hash bytea NOT NULL UNIQUE CHECK (length(key_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX sdk_keys_tenant_id ON public.sdk_keys (tenant_id);

-- actor_user_id has no foreign key: deleting a user leaves the audit rows, which
-- hold the user's id and never a name or an email. id is an identity column, which
-- draws from its sequence without a grant on it, so rff_app holds no privilege on
-- any sequence. The sequence is shared by all tenants, so the gaps between one
-- tenant's ids show how many audit rows the other tenants wrote in between.
CREATE TABLE public.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  before jsonb,
  after jsonb,
  version bigint,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_id_id ON public.audit_log (tenant_id, id);

ALTER TYPE public.member_role OWNER TO rff_owner;
ALTER TABLE public.tenants OWNER TO rff_owner;
ALTER TABLE public.users OWNER TO rff_owner;
ALTER TABLE public.memberships OWNER TO rff_owner;
ALTER TABLE public.flags OWNER TO rff_owner;
ALTER TABLE public.sdk_keys OWNER TO rff_owner;
ALTER TABLE public.audit_log OWNER TO rff_owner;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sdk_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sdk_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

-- One policy per tenant table, for every command: a row is visible, and a written
-- row is accepted, only when its tenant is the current one.
CREATE POLICY tenant_isolation ON public.tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON public.memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON public.flags
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON public.sdk_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON public.audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- users has no tenant_id. A user row is visible when it is the current user
-- (app.user_id), or when the user is a member of the current tenant (app.tenant_id),
-- which the member list needs. A user who shares no tenant with the current one
-- stays invisible, and so does every user when neither setting is set. The
-- memberships read inside the policy is itself limited to the current tenant.
-- There is no policy for INSERT, UPDATE or DELETE, so row-level security refuses
-- them whatever is granted; rff_app holds only SELECT here.
CREATE POLICY self_or_co_member ON public.users
  FOR SELECT
  USING (
    id = NULLIF(current_setting('app.user_id', true), '')::uuid
    OR EXISTS (
      SELECT FROM public.memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

-- Only for the look-up functions below, which run as rff_owner.
CREATE POLICY lookup_by_owner ON public.users FOR SELECT TO rff_owner USING (true);
CREATE POLICY lookup_by_owner ON public.memberships FOR SELECT TO rff_owner USING (true);
CREATE POLICY lookup_by_owner ON public.sdk_keys FOR SELECT TO rff_owner USING (true);

-- rff_app's privileges follow the API's routes. There is no TRUNCATE anywhere, no
-- privilege on a sequence, only INSERT and SELECT on audit_log, and UPDATE only on
-- the columns a route changes: a tenant's version, a member's role, and a flag's
-- enabled, rules, rollout_bp and updated_at. No UPDATE reaches a tenant_id, so no
-- update can move a row to another tenant.
GRANT USAGE ON SCHEMA public TO rff_app;
GRANT SELECT, UPDATE (version) ON public.tenants TO rff_app;
GRANT SELECT ON public.users TO rff_app;
GRANT SELECT, UPDATE (role) ON public.memberships TO rff_app;
GRANT SELECT, INSERT, DELETE, UPDATE (enabled, rules, rollout_bp, updated_at)
  ON public.flags TO rff_app;
GRANT SELECT, INSERT ON public.sdk_keys TO rff_app;
GRANT SELECT, INSERT ON public.audit_log TO rff_app;

-- The look-ups that run before the tenant is known. Each returns one value or NULL
-- and nothing about any other row, and none reads a setting, so the result is the
-- same whatever app.tenant_id and app.user_id hold. The SQL-standard bodies are
-- parsed here, with the tables named by schema, and search_path is fixed to
-- pg_catalog then pg_temp, so a caller's search_path cannot redirect a name.

-- The user signed in as (issuer, subject), or NULL. Only the id comes back.
CREATE FUNCTION public.user_id_for_subject(p_issuer text, p_subject text)
  RETURNS uuid
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (
    SELECT u.id FROM public.users u
    WHERE u.idp_issuer = p_issuer AND u.idp_subject = p_subject
  );

-- The user's role in the tenant, or NULL when the user is not a member of it.
CREATE FUNCTION public.member_role_in_tenant(p_user_id uuid, p_tenant_id uuid)
  RETURNS public.member_role
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (
    SELECT m.role FROM public.memberships m
    WHERE m.user_id = p_user_id AND m.tenant_id = p_tenant_id
  );

-- The tenant of the SDK key with this SHA-256 hash, or NULL when there is no such
-- key or it was revoked.
CREATE FUNCTION public.tenant_id_for_sdk_key(p_key_hash bytea)
  RETURNS uuid
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (
    SELECT k.tenant_id FROM public.sdk_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
  );

ALTER FUNCTION public.user_id_for_subject(text, text) OWNER TO rff_owner;
ALTER FUNCTION public.member_role_in_tenant(uuid, uuid) OWNER TO rff_owner;
ALTER FUNCTION public.tenant_id_for_sdk_key(bytea) OWNER TO rff_owner;

REVOKE ALL ON FUNCTION public.user_id_for_subject(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.member_role_in_tenant(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_id_for_sdk_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_id_for_subject(text, text) TO rff_app;
GRANT EXECUTE ON FUNCTION public.member_role_in_tenant(uuid, uuid) TO rff_app;
GRANT EXECUTE ON FUNCTION public.tenant_id_for_sdk_key(bytea) TO rff_app;
