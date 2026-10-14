import { describe, expect, it } from 'vitest';

it('adds two numbers', () => {
  expect(1 + 1).toBe(2);
});

describe('a group', () => {
  it('passes inside a describe block', () => {
    expect(true).toBe(true);
  });
});

it.skip('is skipped', () => {
  expect(true).toBe(true);
});

it.todo('is a todo');

it('fails', () => {
  expect(1 + 1).toBe(3);
});
