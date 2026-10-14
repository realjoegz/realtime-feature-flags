-- The look-up functions of migrations 0002 and 0003, each with one defect, and one
-- SECURITY DEFINER function that is not on the allow-list. The control in
-- isolation-tables.test.ts applies this file to a scratch database and expects the
-- look-up cases and the allow-list check to report every one of them.

-- Ignores the issuer: the same subject at another identity provider signs in as
-- this user.
CREATE OR REPLACE FUNCTION public.user_id_for_subject(p_issuer text, p_subject text)
  RETURNS uuid
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (SELECT u.id FROM public.users u WHERE u.idp_subject = p_subject LIMIT 1);

-- Prefers the session's app.tenant_id to the tenant it was asked about.
CREATE OR REPLACE FUNCTION public.member_role_in_tenant(p_user_id uuid, p_tenant_id uuid)
  RETURNS public.member_role
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (
    SELECT m.role FROM public.memberships m
    WHERE m.user_id = p_user_id
      AND m.tenant_id = coalesce(
        NULLIF(current_setting('app.tenant_id', true), '')::uuid, p_tenant_id)
  );

-- Ignores revocation.
CREATE OR REPLACE FUNCTION public.tenant_id_for_sdk_key(p_key_hash bytea)
  RETURNS uuid
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (SELECT k.tenant_id FROM public.sdk_keys k WHERE k.key_hash = p_key_hash);

-- Lists the memberships of the session's app.user_id when one is set, instead of
-- those of the user it was asked about.
CREATE OR REPLACE FUNCTION public.memberships_of_user(p_user_id uuid)
  RETURNS jsonb
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  RETURN (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('tenantId', t.id, 'slug', t.slug, 'name', t.name, 'role', m.role)
        ORDER BY t.slug COLLATE "C"
      ),
      '[]'::jsonb
    )
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.user_id = coalesce(NULLIF(current_setting('app.user_id', true), '')::uuid, p_user_id)
  );

-- Every user's email, to anyone who can call it.
CREATE FUNCTION public.user_emails()
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  BEGIN ATOMIC
    SELECT u.email FROM public.users u;
  END;
