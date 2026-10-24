import { describe, expect, it } from 'vitest';
import { mergeHandlers } from './index.js';

const handler = () => Promise.resolve(null);

describe('mergeHandlers', () => {
  it('joins handler sets that name different operations', () => {
    expect(Object.keys(mergeHandlers([{ 'a.get': handler }, { 'b.get': handler }]))).toEqual([
      'a.get',
      'b.get',
    ]);
  });

  it('refuses a second handler for one operation, such as a stub left behind by new:op', () => {
    expect(() => mergeHandlers([{ 'tickets.list': handler }, { 'tickets.list': handler }])).toThrow(
      /tickets.list has two handlers/,
    );
  });
});
