import type { Flag } from '@rff/core';
import type { MemberRole } from '../database/tenant-database.js';

// The demo data that the compose stack's seed service writes (seed-main.ts): two
// tenants, the four static users of dex/local-demo-config.yaml, their memberships,
// a few flags and one SDK key per tenant. Every value here is a local demo value,
// published with the repository. scripts/demo.sh uses the users and the SDK keys.

export interface DemoUser {
  /** users.id in the API's database. */
  readonly id: string;
  /** The userID of the static user in the Dex configuration. */
  readonly dexUserId: string;
  readonly email: string;
  readonly name: string;
}

export interface DemoTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly members: readonly { readonly email: string; readonly role: MemberRole }[];
  readonly flags: readonly Flag[];
  /**
   * The SDK key's plaintext, a local demo value. A real key is 32 random bytes; this
   * one has the same form (rff_sdk_ and 43 base64url characters) so that the API
   * accepts it, and its text says what it is.
   */
  readonly sdkKey: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
  {
    id: 'a11ce000-0000-4000-8000-000000000001',
    dexUserId: '7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1001',
    email: 'alice@example.test',
    name: 'Alice',
  },
  {
    id: 'b0b00000-0000-4000-8000-000000000002',
    dexUserId: '7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1002',
    email: 'bob@example.test',
    name: 'Bob',
  },
  {
    id: 'ca201000-0000-4000-8000-000000000003',
    dexUserId: '7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1003',
    email: 'carol@example.test',
    name: 'Carol',
  },
  {
    id: 'da7e0000-0000-4000-8000-000000000004',
    dexUserId: '7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1004',
    email: 'dave@example.test',
    name: 'Dave',
  },
];

// Both tenants have a flag new-checkout, with different settings, as the isolation
// tests' tenants A and B share flag keys.
export const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    id: 'ac3e0000-0000-4000-8000-000000000001',
    slug: 'acme',
    name: 'Acme',
    members: [
      { email: 'alice@example.test', role: 'owner' },
      { email: 'carol@example.test', role: 'editor' },
      { email: 'bob@example.test', role: 'viewer' },
    ],
    flags: [
      {
        key: 'new-checkout',
        enabled: true,
        salt: '3f1a9c0d7e2b4a65',
        rules: [{ attribute: 'plan', operator: 'equals', values: ['beta'], serve: true }],
        rolloutBasisPoints: 2500,
      },
      {
        key: 'dark-mode',
        enabled: false,
        salt: '8b04e6d2c9f15a37',
        rules: [],
        rolloutBasisPoints: 0,
      },
      {
        key: 'search-v2',
        enabled: true,
        salt: 'c52d7f81a3e60b94',
        rules: [{ attribute: 'country', operator: 'in', values: ['NL', 'BE'], serve: false }],
        rolloutBasisPoints: 10000,
      },
    ],
    sdkKey: 'rff_sdk_acme-local-demo-key-not-a-secret00000000000',
  },
  {
    id: '610be000-0000-4000-8000-000000000002',
    slug: 'globex',
    name: 'Globex',
    members: [
      { email: 'dave@example.test', role: 'owner' },
      { email: 'bob@example.test', role: 'editor' },
    ],
    flags: [
      {
        key: 'new-checkout',
        enabled: false,
        salt: 'e7a3016b5c9d24f8',
        rules: [],
        rolloutBasisPoints: 0,
      },
      {
        key: 'beta-banner',
        enabled: true,
        salt: '1d9e4b7a0c6f3285',
        rules: [],
        rolloutBasisPoints: 5000,
      },
    ],
    sdkKey: 'rff_sdk_globex-local-demo-key-not-a-secret000000000',
  },
];
