// @module-tag drop-a
// Item restrictedFields against the oracle: through items.get and items.list, a restricted
// field never reaches a caller who may not see it (not its value, not even whether it is
// set), and the harness fails when a read stops masking them.
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import { createItemsService, writePath, type ItemRecord } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, maskProperty, oracle, type FieldRead } from './leak.js';
import { testKeys } from './keys.js';

const options = leakRunOptions();

/** The maskable fields a record shows: everything not rendered masked. */
const shown = (item: ItemRecord) =>
  (['cost', 'bookingRef', 'cardLast4'] as const).filter((field) => item[field] !== 'masked');

/** Swallows not_found: a trip or item the caller is not in reads as nothing. */
async function orNothing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') return null;
    throw error;
  }
}

/* eslint-disable no-await-in-loop -- one transaction, so one query at a time */
const getEach: FieldRead = async (db, userId) => {
  const items = createItemsService(db, writePath(db), testKeys());
  const ids = await db.selectFrom('tribo.items').select('id').execute();
  const out = [];
  for (const { id } of ids) {
    const item = await orNothing(items.get(userId, id));
    if (item) out.push({ id, shown: shown(item) });
  }
  return out;
};

const listEach: FieldRead = async (db, userId) => {
  const items = createItemsService(db, writePath(db), testKeys());
  const trips = await db.selectFrom('tribo.trips').select('id').execute();
  const out = [];
  for (const trip of trips) {
    const page = await orNothing(items.list(userId, trip.id, { limit: PAGE_LIMIT_MAX }));
    for (const item of page?.items ?? []) out.push({ id: item.id, shown: shown(item) });
  }
  return out;
};
/* eslint-enable no-await-in-loop */

const property = (tdb: TestDatabase, read: FieldRead) =>
  maskProperty(tdb.db, read, (world, userId, itemId, field) =>
    oracle.fieldReadable(world, userId, itemId, field),
  );

describe('item restrictedFields against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`items.get never shows a restricted field to a caller who may not see it (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(property(tdb, getEach), options);
  });

  it('items.list never does either', async () => {
    await fc.assert(property(tdb, listEach), options);
  });

  it('mutation check: the harness catches a read that shows every field', async () => {
    const leaky: FieldRead = async (db, userId) =>
      (await getEach(db, userId)).map(({ id }) => ({
        id,
        shown: ['cost', 'bookingRef', 'cardLast4'],
      }));
    const result = await fc.check(property(tdb, leaky), options);
    expect(result.failed).toBe(true);
  });
});
