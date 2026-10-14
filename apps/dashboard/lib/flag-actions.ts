'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, getFlag, getMe, updateFlag } from './api';
import { currentSession } from './current-session';
import { parseFlagChange } from './flag-input';

// The flag form's server action. Anyone who can send the POST can call it, whatever
// the page showed, so it checks everything itself: the session, the fields, and the
// user's role in the tenant, read from the API for this request. Only then does it
// send the change, as the user, and the API checks the role once more.

export interface SaveResult {
  readonly ok: boolean;
  readonly message: string;
}

// The same answer for a tenant the user is not in as for one that does not exist.
const NOT_FOUND: SaveResult = { ok: false, message: 'Not found.' };

export async function saveFlag(_previous: SaveResult | null, form: FormData): Promise<SaveResult> {
  const session = await currentSession();
  if (session === null) redirect('/auth/login');
  const parsed = parseFlagChange(form);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const { tenantId, flagKey, enabled, rolloutBasisPoints } = parsed.change;
  let saved: { version: number };
  try {
    const me = await getMe(session);
    const membership = me.memberships.find((entry) => entry.tenantId === tenantId);
    if (membership === undefined) return NOT_FOUND;
    if (membership.role === 'viewer') {
      return { ok: false, message: 'Viewers cannot change flags.' };
    }
    // The form changes enabled and the rollout; the rules stay as they are.
    const flag = await getFlag(session, tenantId, flagKey);
    saved = await updateFlag(session, tenantId, flagKey, {
      enabled,
      rules: flag.rules,
      rolloutBasisPoints,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) redirect('/signed-out?reason=refused');
    if (error.status === 404) return NOT_FOUND;
    if (error.status === 403) {
      return { ok: false, message: 'Your role does not allow this change.' };
    }
    return { ok: false, message: `The API answered ${error.status}.` };
  }
  // Renders the page again in the same response, with the saved values.
  refresh();
  return { ok: true, message: `Saved as version ${saved.version}.` };
}
