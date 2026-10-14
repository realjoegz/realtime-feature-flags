import { decodeProtectedHeader } from 'jose';
import { expect } from 'vitest';

// Checks that a cookie value is encrypted, not only signed. A JWS or plain base64url
// JSON that holds the access token passes a check that looks for the token in the
// value as it stands, so this one also decodes every segment.

/**
 * Asserts that value is a compact JWE with the header lib/cookies.ts writes (dir
 * with A256GCM: five segments, the second empty) and that neither the value nor any
 * of its segments, base64url-decoded, contains one of the hidden strings.
 */
export function expectSealed(value: string, typ: string, hidden: readonly string[]): void {
  const segments = value.split('.');
  expect(segments).toHaveLength(5);
  expect(segments[1]).toBe('');
  expect(decodeProtectedHeader(value)).toEqual({ alg: 'dir', enc: 'A256GCM', typ });
  const readable = [
    value,
    ...segments.map((segment) => Buffer.from(segment, 'base64url').toString('latin1')),
  ];
  for (const text of hidden) {
    expect(text.length).toBeGreaterThan(0);
    for (const part of readable) expect(part).not.toContain(text);
  }
}
