import { expect, it } from 'vitest';

// Two tests with the same name: the first passes and the second fails.
it('shares a name', () => {
  expect(true).toBe(true);
});

it('shares a name', () => {
  expect(true).toBe(false);
});
