import { notFound } from 'next/navigation';
import { getMe, type Membership } from '../../../lib/api';
import type { Session } from '../../../lib/cookies';
import { fromApi } from '../../../lib/current-session';
import { isTenantId } from '../../../lib/flag-input';

/**
 * The user's membership in the tenant of the path, from GET /me. A tenant the user
 * is not in renders the not-found page, as a tenant that does not exist does.
 */
export async function membershipIn(session: Session, tenantId: string): Promise<Membership> {
  if (!isTenantId(tenantId)) notFound();
  const me = await fromApi(() => getMe(session));
  const membership = me.memberships.find((entry) => entry.tenantId === tenantId);
  if (membership === undefined) notFound();
  return membership;
}
