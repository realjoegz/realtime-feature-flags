import Link from 'next/link';
import { getMe } from '../lib/api';
import { fromApi, requireSession } from '../lib/current-session';
import { Header } from './header';

/** The tenants the signed-in user belongs to, with the role in each. */
export default async function TenantsPage() {
  const session = await requireSession();
  const me = await fromApi(() => getMe(session));
  return (
    <>
      <Header session={session} />
      <main>
        <h1>Tenants</h1>
        {me.memberships.length === 0 ? (
          <p>You are not a member of any tenant.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Slug</th>
                <th>Your role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {me.memberships.map((membership) => (
                <tr key={membership.tenantId}>
                  <td>{membership.name}</td>
                  <td>
                    <code>{membership.slug}</code>
                  </td>
                  <td>{membership.role}</td>
                  <td className="links">
                    <Link href={`/tenants/${membership.tenantId}/flags`}>Flags</Link>
                    <Link href={`/tenants/${membership.tenantId}/audit`}>Audit log</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
