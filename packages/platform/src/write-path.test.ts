import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { RequestContext } from './context.js';
import { checkIfMatch, createWritePath, type Tx } from './write-path.js';

describe('createWritePath', () => {
  // No I/O: the transaction is a stand-in, and the ports record nothing.
  const tx = {} as Tx;
  const db = { transaction: () => ({ execute: (fn: (t: Tx) => unknown) => fn(tx) }) };
  const write = createWritePath(db as unknown as Kysely<DB>, {
    guardTrip: () => Promise.resolve(),
    record: () => Promise.resolve(),
  });
  const ctx = { requestId: 'r', userId: 'u' } as RequestContext;
  const operation = { id: 'test.write', ifMatch: 'no', input: z.object({}) } as const;

  it('passes what authorize found to load and mutate', async () => {
    const seen: unknown[] = [];
    const result = await write(ctx, {
      operation: operation as never,
      target: { id: 't' },
      body: {},
      ifMatch: undefined,
      authorize: () => Promise.resolve({ acting: 'editor' }),
      load: (_tx, _target, _input, auth) => {
        seen.push(auth);
        return Promise.resolve({ tripId: null });
      },
      mutate: (_tx, _c, _loaded, _input, auth) => {
        seen.push(auth);
        return Promise.resolve({
          action: 'create',
          aggregate: 'test',
          entityId: 'e',
          tripId: null,
          version: 1,
          snapshot: {},
          result: auth.acting,
        });
      },
    });
    expect(seen).toEqual([{ acting: 'editor' }, { acting: 'editor' }]);
    expect(result).toBe('editor');
  });
});

describe('checkIfMatch', () => {
  it('ignores If-Match on operations that declare none', () => {
    expect(() => {
      checkIfMatch('no', undefined, 3);
    }).not.toThrow();
    expect(() => {
      checkIfMatch('no', 1, 3);
    }).not.toThrow();
  });

  it.each(['version', 'board_version', 'budget_version'] as const)(
    '%s: requires the header and matches it against the loaded counter',
    (declared) => {
      expect(() => {
        checkIfMatch(declared, undefined, 3);
      }).toThrow(expect.objectContaining({ code: 'if_match_required' }));
      expect(() => {
        checkIfMatch(declared, 2, 3);
      }).toThrow(expect.objectContaining({ code: 'version_conflict' }));
      expect(() => {
        checkIfMatch(declared, 3, 3);
      }).not.toThrow();
    },
  );

  it('version_or_new needs If-Match only once the aggregate exists', () => {
    expect(() => {
      checkIfMatch('version_or_new', undefined, undefined);
    }).not.toThrow();
    expect(() => {
      checkIfMatch('version_or_new', undefined, 1);
    }).toThrow(expect.objectContaining({ code: 'if_match_required' }));
  });

  it('treats a counter operation that loaded no counter as a programming error', () => {
    expect(() => {
      checkIfMatch('version', 1, undefined);
    }).toThrow(/loaded no counter/);
  });
});
