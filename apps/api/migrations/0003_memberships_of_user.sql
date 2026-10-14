-- The tenants a user belongs to, for GET /me.
--
-- rff_app sees memberships only within the current tenant (0002), so a list across
-- tenants needs a look-up of its own, like the three in 0002. It returns one jsonb
-- array for the given user and nothing about any other user, and it reads no
-- setting, so the result is the same whatever app.tenant_id and app.user_id hold.

-- FORCE ROW LEVEL SECURITY applies the tenant policy to rff_owner too, so the
-- function below, which runs as rff_owner, could not read the tenants it lists.
CREATE POLICY lookup_by_owner ON public.tenants FOR SELECT TO rff_owner USING (true);

-- One element per membership, ordered by slug in byte order:
-- {"name": ..., "role": ..., "slug": ..., "tenantId": ...}. A user in no tenant, or
-- an id that names no user, gives an empty array.
CREATE FUNCTION public.memberships_of_user(p_user_id uuid)
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
    WHERE m.user_id = p_user_id
  );

ALTER FUNCTION public.memberships_of_user(uuid) OWNER TO rff_owner;
REVOKE ALL ON FUNCTION public.memberships_of_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.memberships_of_user(uuid) TO rff_app;
