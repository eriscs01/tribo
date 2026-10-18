import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';
import { ApiError } from './errors.js';

describe('keyset cursor', () => {
  it('round-trips its sort key', () => {
    const key = ['2026-11-11', '0195f0c2-7a3e-7000-8000-000000000001'];
    expect(decodeCursor(encodeCursor(key), 2)).toEqual(key);
  });

  it.each([
    ['not base64 JSON', '!!!'],
    ['the wrong size', encodeCursor(['only one'])],
    ['non-string parts', Buffer.from('[1,2]').toString('base64url')],
  ])('refuses %s as validation_failed', (_name, cursor) => {
    expect(() => decodeCursor(cursor, 2)).toThrow(ApiError);
    try {
      decodeCursor(cursor, 2);
    } catch (error) {
      expect((error as ApiError).code).toBe('validation_failed');
    }
  });
});
