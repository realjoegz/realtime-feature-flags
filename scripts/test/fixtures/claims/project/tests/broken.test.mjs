import { expect, it } from 'vitest';

throw new Error('fixture: this file fails to load');

it('never registers', () => {
  expect(true).toBe(true);
});
