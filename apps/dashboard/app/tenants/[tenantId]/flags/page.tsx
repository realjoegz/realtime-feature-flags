import { listFlags } from '../../../../lib/api';
import { fromApi, requireSession } from '../../../../lib/current-session';
import { Header } from '../../../header';
import { membershipIn } from '../load';
import { TenantNav } from '../tenant-nav';
import { FlagForm } from './flag-form';

/**
 * The tenant's flags. Editors and owners can switch a flag on or off and change its
 * rollout; viewers see the same controls, disabled.
 */
export default async function FlagsPage({ params }: PageProps<'/tenants/[tenantId]/flags'>) {
  const { tenantId } = await params;
  const session = await requireSession();
  const membership = await membershipIn(session, tenantId);
  const { version, flags } = await fromApi(() => listFlags(session, tenantId));
  const editable = membership.role !== 'viewer';
  return (
    <>
      <Header session={session} />
      <main>
        <TenantNav membership={membership} current="flags" />
        <p className="muted">
          Version {version}. {editable ? null : 'Viewers cannot change flags.'}
        </p>
        {flags.length === 0 ? (
          <p>No flags yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Flag</th>
                <th>Rules</th>
                <th>Enabled and rollout</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.key}>
                  <td>
                    <code>{flag.key}</code>
                  </td>
                  <td>{flag.rules.length}</td>
                  <td>
                    <FlagForm
                      // A new version renders the form again with the saved values.
                      key={`${flag.key}@${version}`}
                      tenantId={tenantId}
                      flagKey={flag.key}
                      enabled={flag.enabled}
                      rolloutBasisPoints={flag.rolloutBasisPoints}
                      editable={editable}
                    />
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
