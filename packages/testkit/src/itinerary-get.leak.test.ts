// @module-tag drop-a
// itinerary.get against the oracle: every account's timeline names exactly the dated items
// it may see, shows an amount only where it may read money, and comes out the same when
// every item hidden from it is gone, so no hidden item reaches it as a line or a warning.
import { createItineraryService, type ItineraryRecord } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import type { DB } from '@tribo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import {
  leakRunOptions,
  listProperty,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type ListRead,
} from './leak.js';

const options = leakRunOptions();

/** The itinerary of every trip in the database, in one view; a trip not the caller's reads nothing. */
async function itineraries(
  db: Kysely<DB>,
  userId: string,
  view: 'me' | 'group',
): Promise<ItineraryRecord[]> {
  const itinerary = createItineraryService(db);
  const trips = await db.selectFrom('tribo.trips').select('id').orderBy('id').execute();
  const out: ItineraryRecord[] = [];
  for (const trip of trips) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      out.push(await itinerary.get(userId, trip.id, { view }));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return out;
}

/** Every item id the group view names anywhere: its lines, its items and its warnings. */
const named: ListRead = async (db, userId) => {
  const ids = new Set<string>();
  for (const read of await itineraries(db, userId, 'group')) {
    for (const d of read.days) for (const e of d.entries) ids.add(e.itemId);
    for (const i of read.items) ids.add(i.id);
    for (const w of read.warnings) {
      ids.add(w.itemId);
      if (w.withItemId !== undefined) ids.add(w.withItemId);
    }
  }
  return [...ids];
};

const namesVisible = (tdb: TestDatabase) =>
  listProperty(
    tdb.db,
    named,
    (world) => world.trips.flatMap((t) => t.items.filter((i) => i.dated).map((i) => i.id)),
    (world, userId, id) => oracle.itemVisible(world, userId, id),
  );

describe('itinerary.get against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`names exactly the dated items the caller may see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(namesVisible(tdb), options);
  });

  it('shows an amount only to a caller who may read that item’s money', async () => {
    const priced: ListRead = async (db, userId) =>
      (await itineraries(db, userId, 'group')).flatMap((read) =>
        read.items.filter((i) => i.cost !== null && i.cost !== 'masked').map((i) => i.id),
      );
    await fc.assert(
      listProperty(
        tdb.db,
        priced,
        (world) =>
          world.trips.flatMap((t) => t.items.filter((i) => i.dated && i.priced).map((i) => i.id)),
        (world, userId, id) =>
          oracle.itemVisible(world, userId, id) && oracle.moneyReadable(world, userId, id),
      ),
      options,
    );
  });

  it('reads the same, both views, with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const problems: string[] = [];
        for (const userId of world.userIds) {
          for (const view of ['group', 'me'] as const) {
            // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
            const { before, after } = await withoutHiddenItems(trx, world, userId, () =>
              itineraries(trx, userId, view),
            );
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              problems.push(`${userId} (${view}) reads hidden items: ${JSON.stringify(before)}`);
            }
          }
        }
        return problems;
      }),
      options,
    );
  });
});

describe('mutation check: the harness catches an itinerary that shows private items to everyone', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    // Break item_visible in this database only: a private item counts as shared.
    const owner = connectAs(tdb.name, 'tribo_owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ def: string }>(
        `SELECT pg_get_functiondef('tribo.item_visible(uuid, uuid)'::regprocedure) AS def`,
      );
      const def = rows[0]?.def ?? '';
      const broken = def.replace(/i\.visibility = 'shared'/, `i.visibility <> 'selected'`);
      expect(broken).not.toBe(def);
      await owner.query(broken);
    } finally {
      await owner.end();
    }
  });
  afterAll(() => tdb.destroy());

  it('fails the property', async () => {
    const result = await fc.check(namesVisible(tdb), options);
    expect(result.failed).toBe(true);
  });
});
