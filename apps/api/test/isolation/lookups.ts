import { randomBytes, randomUUID } from 'node:crypto';
import type { AllowedDefiner, LookupCase, SettingValue } from './detectors.js';
import type { Fixture } from './fixture.js';

// The SECURITY DEFINER functions of migration 0002 and the calls that show each one
// returns the caller's row or NULL, and nothing about any other row. A new SECURITY
// DEFINER function fails the allow-list check until it is listed here with cases.

const LOOKUP: AllowedDefiner = { owner: 'rff_owner', config: ['search_path=pg_catalog, pg_temp'] };

export const USER_LOOKUP = 'public.user_id_for_subject(text, text)';
export const ROLE_LOOKUP = 'public.member_role_in_tenant(uuid, uuid)';
export const KEY_LOOKUP = 'public.tenant_id_for_sdk_key(bytea)';

export const DEFINER_ALLOW_LIST: Readonly<Record<string, AllowedDefiner>> = {
  [USER_LOOKUP]: LOOKUP,
  [ROLE_LOOKUP]: LOOKUP,
  [KEY_LOOKUP]: LOOKUP,
};

function userCase(
  label: string,
  issuer: string | null,
  subject: string | null,
  expected: string | null,
): LookupCase {
  return {
    signature: USER_LOOKUP,
    label: `user for ${label}`,
    sql: 'SELECT public.user_id_for_subject($1::text, $2::text) AS value',
    params: [issuer, subject],
    expected,
  };
}
function roleCase(
  label: string,
  userId: string | null,
  tenantId: string | null,
  expected: string | null,
): LookupCase {
  return {
    signature: ROLE_LOOKUP,
    label: `role of ${label}`,
    sql: 'SELECT public.member_role_in_tenant($1::uuid, $2::uuid)::text AS value',
    params: [userId, tenantId],
    expected,
  };
}
function keyCase(label: string, hash: Buffer | null, expected: string | null): LookupCase {
  return {
    signature: KEY_LOOKUP,
    label: `tenant for ${label}`,
    sql: 'SELECT public.tenant_id_for_sdk_key($1::bytea) AS value',
    params: [hash],
    expected,
  };
}

export function lookupCases(fixture: Fixture): LookupCase[] {
  const { shared, aEditor, aViewer, bEditor, nobody } = fixture.users;
  const { tenantA: A, tenantB: B } = fixture;
  const unknownUser = randomUUID();
  const unknownTenant = randomUUID();

  const { aActive, aRevoked, bActive } = fixture.sdkKeys;

  return [
    userCase("the shared user's issuer and subject", shared.issuer, shared.subject, shared.id),
    userCase("A's editor's issuer and subject", aEditor.issuer, aEditor.subject, aEditor.id),
    userCase("B's editor's issuer and subject", bEditor.issuer, bEditor.subject, bEditor.id),
    userCase('a user in no tenant', nobody.issuer, nobody.subject, nobody.id),
    userCase("the shared user's subject at another issuer", aEditor.issuer, shared.subject, null),
    userCase(
      "another user's subject at the shared user's issuer",
      shared.issuer,
      aEditor.subject,
      null,
    ),
    userCase('the subject in upper case', shared.issuer, shared.subject.toUpperCase(), null),
    userCase('the issuer with a trailing slash', `${shared.issuer}/`, shared.subject, null),
    userCase('LIKE wildcards', '%', '%', null),
    userCase('an empty subject', shared.issuer, '', null),
    userCase('NULL', null, null, null),

    roleCase('the shared user in A', shared.id, A, 'owner'),
    roleCase('the shared user in B', shared.id, B, 'viewer'),
    roleCase("A's editor in A", aEditor.id, A, 'editor'),
    roleCase("A's viewer in A", aViewer.id, A, 'viewer'),
    roleCase("B's editor in B", bEditor.id, B, 'editor'),
    roleCase("A's editor in B", aEditor.id, B, null),
    roleCase("B's editor in A", bEditor.id, A, null),
    roleCase('a user in no tenant, in A', nobody.id, A, null),
    roleCase('a user in no tenant, in B', nobody.id, B, null),
    roleCase('the shared user in an unknown tenant', shared.id, unknownTenant, null),
    roleCase('an unknown user in A', unknownUser, A, null),
    roleCase('NULL user in A', null, A, null),
    roleCase('the shared user in a NULL tenant', shared.id, null, null),

    keyCase("A's active key", aActive.hash, A),
    keyCase("B's active key", bActive.hash, B),
    keyCase("A's revoked key", aRevoked.hash, null),
    keyCase('an unknown hash', randomBytes(32), null),
    keyCase("the first 31 bytes of A's hash", aActive.hash.subarray(0, 31), null),
    keyCase("A's key itself instead of its hash", Buffer.from(aActive.key), null),
    keyCase('an empty hash', Buffer.alloc(0), null),
    keyCase('NULL', null, null),
  ];
}

/** Never set, the empty string a reused connection holds, A, B and an unknown id. */
export function settingValues(fixture: Fixture): {
  tenant: SettingValue[];
  user: SettingValue[];
} {
  return {
    tenant: [
      { label: 'never set', value: undefined },
      { label: "''", value: '' },
      { label: 'A', value: fixture.tenantA },
      { label: 'B', value: fixture.tenantB },
      { label: 'an unknown tenant', value: randomUUID() },
    ],
    user: [
      { label: 'never set', value: undefined },
      { label: "''", value: '' },
      { label: 'the shared user', value: fixture.users.shared.id },
      { label: "A's editor", value: fixture.users.aEditor.id },
      { label: 'a user in no tenant', value: fixture.users.nobody.id },
    ],
  };
}
