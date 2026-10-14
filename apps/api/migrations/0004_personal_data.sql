-- Export and deletion of a dashboard user's personal data: GET /me/export and
-- DELETE /me (apps/api/src/me/personal-data.ts).
--
-- A user's personal data is the issuer, subject, email and name in users, and the
-- user's memberships. DELETE /me sets the four columns to NULL and keeps the row, so
-- the audit rows that name the user as actor keep an id that maps to no person. It
-- deletes the user's membership in each tenant, and writes that tenant's audit row,
-- in that tenant's context (TenantDatabase.withUserAcrossTenants): each statement
-- still reads and writes the rows of one tenant, and the tenant_isolation policies
-- of 0002 apply unchanged.
--
-- The grants and policies below are per command. rff_app may UPDATE a user row only
-- to erase it, and only the row of app.user_id. It may DELETE a membership only of
-- app.user_id, and only in the current tenant.

-- An erased user has all four columns NULL. UNIQUE (idp_issuer, idp_subject) treats
-- NULLs as distinct, so any number of erased users can exist, and
-- user_id_for_subject compares with =, which no NULL passes, so no token names one.
ALTER TABLE public.users
  ALTER COLUMN idp_issuer DROP NOT NULL,
  ALTER COLUMN idp_subject DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN name DROP NOT NULL,
  ADD CONSTRAINT users_erased_all_or_none
    CHECK (pg_catalog.num_nulls(idp_issuer, idp_subject, email, name) IN (0, 4));

GRANT UPDATE (idp_issuer, idp_subject, email, name) ON public.users TO rff_app;
GRANT DELETE ON public.memberships TO rff_app;

-- The current user's own row, and only to set the four columns to NULL: a new row
-- that keeps any of them is refused, so rff_app cannot change a user's sign-in or
-- contact details, its own included. An UPDATE that reads columns (a WHERE clause)
-- also needs the row to pass self_or_co_member, which the current user's row does.
CREATE POLICY erase_self ON public.users
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (
    id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND idp_issuer IS NULL
    AND idp_subject IS NULL
    AND email IS NULL
    AND name IS NULL
  );

-- tenant_isolation already limits a DELETE to the current tenant. This restrictive
-- policy limits it further to the current user's membership, so the DELETE grant
-- removes no other member. With no user set (a request made with an SDK key) a
-- DELETE reaches nothing.
CREATE POLICY leave_self ON public.memberships
  AS RESTRICTIVE
  FOR DELETE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
