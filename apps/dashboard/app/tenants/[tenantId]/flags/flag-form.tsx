'use client';

import { useActionState } from 'react';
import { type SaveResult, saveFlag } from '../../../../lib/flag-actions';
import { percentOf } from '../../../../lib/flag-input';

export interface FlagFormProps {
  readonly tenantId: string;
  readonly flagKey: string;
  readonly enabled: boolean;
  readonly rolloutBasisPoints: number;
  /** False for viewers: the controls are disabled and there is no save button. */
  readonly editable: boolean;
}

/** One flag's enabled switch and rollout percentage, saved by the saveFlag action. */
export function FlagForm({
  tenantId,
  flagKey,
  enabled,
  rolloutBasisPoints,
  editable,
}: FlagFormProps) {
  const [result, action, pending] = useActionState<SaveResult | null, FormData>(saveFlag, null);
  return (
    <form action={action} className="flag-form">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="flagKey" value={flagKey} />
      <label>
        <input type="checkbox" name="enabled" defaultChecked={enabled} disabled={!editable} />{' '}
        Enabled
      </label>
      <label>
        Rollout{' '}
        <input
          type="number"
          name="percent"
          min="0"
          max="100"
          step="0.01"
          required
          defaultValue={percentOf(rolloutBasisPoints)}
          disabled={!editable}
          aria-label={`Rollout of ${flagKey} in percent`}
        />{' '}
        %
      </label>
      {editable ? (
        <button type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save'}
        </button>
      ) : null}
      {result === null ? null : (
        <span role="status" className={result.ok ? 'saved' : 'refused'}>
          {result.message}
        </span>
      )}
    </form>
  );
}
