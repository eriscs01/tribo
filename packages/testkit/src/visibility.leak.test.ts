import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, visibilityProperty } from './leak.js';

const options = leakRunOptions();

describe('visibility predicates against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`item_visible and person_visible agree for every pair (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(visibilityProperty(tdb.db), options);
  });
});

describe('mutation check: the harness catches a broken predicate', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    // Break the `selected` clause in this database only: selected items fall back to
    // owner-only, so members listed in item_shares lose access.
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ def: string }>(
        `SELECT pg_get_functiondef('tribo.item_visible(uuid, uuid)'::regprocedure) AS def`,
      );
      const def = rows[0]?.def ?? '';
      const broken = def.replace(
        /OR \(i\.visibility = 'selected' AND EXISTS\s*\(SELECT 1 FROM tribo\.item_shares s WHERE s\.item_id = i\.id AND s\.membership_id = m\.id\)\)/,
        '',
      );
      expect(broken).not.toBe(def);
      await owner.query(broken);
    } finally {
      await owner.end();
    }
  });
  afterAll(() => tdb.destroy());

  it('fails the property', async () => {
    const result = await fc.check(visibilityProperty(tdb.db), options);
    expect(result.failed).toBe(true);
  });
});
