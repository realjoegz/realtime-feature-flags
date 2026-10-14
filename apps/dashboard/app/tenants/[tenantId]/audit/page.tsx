import { listAudit, listMembers } from '../../../../lib/api';
import { fromApi, requireSession } from '../../../../lib/current-session';
import { Header } from '../../../header';
import { membershipIn } from '../load';
import { TenantNav } from '../tenant-nav';

function json(value: unknown): string {
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

/**
 * The tenant's latest 100 audit rows, newest first. A row names its actor by user id;
 * the page shows the name of an actor who is still a member.
 */
export default async function AuditPage({ params }: PageProps<'/tenants/[tenantId]/audit'>) {
  const { tenantId } = await params;
  const session = await requireSession();
  const membership = await membershipIn(session, tenantId);
  const [{ entries }, { members }] = await fromApi(() =>
    Promise.all([listAudit(session, tenantId), listMembers(session, tenantId)]),
  );
  const names = new Map(members.map((member) => [member.userId, member.name ?? member.email]));
  return (
    <>
      <Header session={session} />
      <main>
        <TenantNav membership={membership} current="audit" />
        {entries.length === 0 ? (
          <p>No changes yet.</p>
        ) : (
          <table className="audit">
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Version</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.at.replace('T', ' ').slice(0, 19)}</td>
                  <td>{names.get(entry.actorUserId) ?? <code>{entry.actorUserId}</code>}</td>
                  <td>{entry.action}</td>
                  <td>
                    <code>{entry.target}</code>
                  </td>
                  <td>{entry.version ?? ''}</td>
                  <td>
                    <code>{json(entry.before)}</code>
                  </td>
                  <td>
                    <code>{json(entry.after)}</code>
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
