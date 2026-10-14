// The flag form's fields, which arrive from the browser and are checked like any
// other input before the server action uses them.

export interface FlagChange {
  readonly tenantId: string;
  readonly flagKey: string;
  readonly enabled: boolean;
  readonly rolloutBasisPoints: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAG_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// 0 to 100 with at most two decimals: one basis point is 0.01 percent.
const PERCENT = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** "25.5" -> 2550, without floating point. */
export function basisPointsOf(percent: string): number | null {
  if (!PERCENT.test(percent)) return null;
  const [whole = '0', fraction = ''] = percent.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 2550 -> "25.5", 2500 -> "25". */
export function percentOf(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

export function parseFlagChange(
  form: FormData,
): { ok: true; change: FlagChange } | { ok: false; message: string } {
  const tenantId = form.get('tenantId');
  const flagKey = form.get('flagKey');
  const enabled = form.get('enabled');
  const percent = form.get('percent');
  if (!isTenantId(tenantId) || typeof flagKey !== 'string' || !FLAG_KEY.test(flagKey)) {
    return { ok: false, message: 'Not found.' };
  }
  if (enabled !== null && enabled !== 'on') {
    return { ok: false, message: 'Enabled must be on or off.' };
  }
  const rolloutBasisPoints = typeof percent === 'string' ? basisPointsOf(percent.trim()) : null;
  if (rolloutBasisPoints === null) {
    return {
      ok: false,
      message: 'The rollout must be a percentage from 0 to 100, with at most two decimals.',
    };
  }
  return { ok: true, change: { tenantId, flagKey, enabled: enabled === 'on', rolloutBasisPoints } };
}
