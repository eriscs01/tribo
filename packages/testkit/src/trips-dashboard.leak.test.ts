// @module-tag drop-a
// trips.dashboard against the oracle: every account reads the dashboard of exactly the trips
// it is in; my share is the oracle's sum when it may read amounts and masked when not; no
// item it cannot see is named anywhere; and the dashboard reads the same with every item
// hidden from it gone, so no hidden item counts as a next item, a task or a warning.
import {
  createDashboardService,
  createTripsService,
  writePath,
  type DashboardRecord,
} from '@tribo/core';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase, type TestDatabase } from './database.js';
import {
  leakRunOptions,
  listProperty,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type BuiltWorld,
} from './leak.js';

const options = leakRunOptions();

/** Every trip's dashboard this account reads, by trip id, at an instant before the world's day. */
async function dashboards(db: Kysely<DB>, userId: string): Promise<Map<string, DashboardRecord>> {
  const dashboard = createDashboardService(db, {
    trips: createTripsService(db, writePath(db)),
    now: () => new Date('2026-11-09T02:00:00Z'),
  });
  const trips = await db.selectFrom('tribo.trips').select('id').orderBy('id').execute();
  const out = new Map<string, DashboardRecord>();
  for (const trip of trips) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one query at a time
      out.set(trip.id, await dashboard.get(userId, trip.id));
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return out;
}

/** Every item a dashboard names, and whether it showed that item's cost. */
function namedItems(d: DashboardRecord): { id: string; costShown: boolean }[] {
  const items = [
    ...(d.nextItem === null ? [] : [d.nextItem]),
    ...d.openTasks,
    ...d.dueSoon.map((s) => s.item),
  ].map((i) => ({ id: i.id, costShown: i.cost !== null && i.cost !== 'masked' }));
  const warned = d.warnings.flatMap((w) => [w.itemId, ...(w.withItemId ? [w.withItemId] : [])]);
  return [...items, ...warned.map((id) => ({ id, costShown: false }))];
}

/** What the oracle forbids in one account's dashboards: hidden items, amounts it may not read. */
async function leaks(trx: Kysely<DB>, world: BuiltWorld, userId: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [tripId, d] of await dashboards(trx, userId)) {
    for (const { id, costShown } of namedItems(d)) {
      if (!oracle.itemVisible(world, userId, id)) problems.push(`${userId} sees hidden item ${id}`);
      if (costShown && !oracle.moneyReadable(world, userId, id)) {
        problems.push(`${userId} reads the cost of ${id}`);
      }
    }
    const expected = oracle.costsReadable(world, userId, tripId)
      ? { amountMinor: oracle.myShare(world, userId, tripId), currency: 'PHP' }
      : 'masked';
    if (JSON.stringify(d.myShare) !== JSON.stringify(expected)) {
      problems.push(`${userId} reads my share ${JSON.stringify(d.myShare)} of ${tripId}`);
    }
  }
  return problems;
}

const namesNothingHidden = (tdb: TestDatabase) =>
  worldProperty(tdb.db, async (trx, world) => {
    const problems: string[] = [];
    for (const userId of world.userIds) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
      problems.push(...(await leaks(trx, world, userId)));
    }
    return problems;
  });

describe('trips.dashboard against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`answers exactly the trips the caller is in (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(
      listProperty(
        tdb.db,
        async (db, userId) => [...(await dashboards(db, userId)).keys()],
        (world) => world.trips.map((t) => t.id),
        (world, userId, id) => oracle.tripVisible(world, userId, id),
      ),
      options,
    );
  });

  it('names no hidden item, shows no amount the caller may not read, and my share as the oracle sums it', async () => {
    await fc.assert(namesNothingHidden(tdb), options);
  });

  it('reads the same with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        const problems: string[] = [];
        for (const userId of world.userIds) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, so one read at a time
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () =>
            JSON.stringify([...(await dashboards(trx, userId))]),
          );
          if (before !== after) problems.push(`${userId}'s dashboard counts hidden items`);
        }
        return problems;
      }),
      options,
    );
  });
});

describe('mutation check: the harness catches a dashboard that shows private items to everyone', () => {
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
    const result = await fc.check(namesNothingHidden(tdb), options);
    expect(result.failed).toBe(true);
  });
});
