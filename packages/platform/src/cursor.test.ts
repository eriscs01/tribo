import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, page, uuidCursor } from './cursor.js';
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

describe('uuidCursor', () => {
  const id = '0195f0c2-7a3e-7000-8000-000000000001';

  it('reads back the id an id-ordered page ended on', () => {
    expect(uuidCursor(encodeCursor([id]))).toBe(id);
  });

  it('refuses a key that is not a UUID before it reaches SQL', () => {
    expect(() => uuidCursor(encodeCursor(['1 OR 1=1']))).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});

describe('page', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyOf = (row: { id: string }) => [row.id];

  it('shows limit rows and points the cursor at the last shown when one more was read', () => {
    const { rows: shown, nextCursor } = page(rows, 2, keyOf);
    expect(shown).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(nextCursor).toBe(encodeCursor(['b']));
  });

  it('has no next cursor when the read came back at or under the limit', () => {
    expect(page(rows, 3, keyOf)).toEqual({ rows, nextCursor: null });
    expect(page([], 3, keyOf)).toEqual({ rows: [], nextCursor: null });
  });
});
