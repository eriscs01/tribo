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
