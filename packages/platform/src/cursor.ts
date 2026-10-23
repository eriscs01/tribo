import { Uuid } from '@tribo/contract';
import { ApiError } from './errors.js';

/**
 * A keyset cursor: the sort key of the last row on a page, as opaque base64url JSON. It
 * names only rows the caller already saw, so it needs no signature; a cursor that does
 * not decode to `size` strings is validation_failed on /cursor.
 */
export function encodeCursor(key: readonly string[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string, size: number): string[] {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    key = null;
  }
  if (Array.isArray(key) && key.length === size && key.every((k) => typeof k === 'string')) {
    return key;
  }
  throw invalidCursor();
}

/** For a list whose cursor decodes but whose key parts are not the shape it sorts by. */
export function invalidCursor(): ApiError {
  return new ApiError('validation_failed', {
    errors: [{ path: '/cursor', message: 'not a cursor from this list' }],
  });
}

/** A cursor over rows in id order; anything but a UUID is refused before it reaches SQL. */
export function uuidCursor(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  const key = Uuid.safeParse(id);
  if (!key.success) throw invalidCursor();
  return key.data;
}

/**
 * One page of a keyset read that asked for `limit + 1` rows: one extra row says whether
 * another page follows, and the cursor names the last row shown.
 */
export function page<R>(
  rows: readonly R[],
  limit: number,
  keyOf: (row: R) => readonly string[],
): { rows: R[]; nextCursor: string | null } {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}
