import Link from 'next/link';
import type { Membership } from '../../../lib/api';

/** The tenant's name, the user's role in it, and its two pages. */
export function TenantNav({
  membership,
  current,
}: {
  membership: Membership;
  current: 'flags' | 'audit';
}) {
  const base = `/tenants/${membership.tenantId}`;
  return (
    <div className="tenant">
      <h1>
        {membership.name} <span className="role">{membership.role}</span>
      </h1>
      <nav>
        <Link href={`${base}/flags`} aria-current={current === 'flags' ? 'page' : undefined}>
          Flags
        </Link>
        <Link href={`${base}/audit`} aria-current={current === 'audit' ? 'page' : undefined}>
          Audit log
        </Link>
      </nav>
    </div>
  );
}
