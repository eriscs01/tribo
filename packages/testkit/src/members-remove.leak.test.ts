// @module-tag drop-a
// members.remove against the oracle: in generated worlds, the owner removes one member
// through the service, and then every account reads exactly what the oracle allows of the
// world after the removal. The removed member sees nothing of the trip (its items, boards,
// members, itinerary and dashboard), and the private items they owned are hidden from
// everyone (R32).
import { PAGE_LIMIT_MAX } from '@tribo/contract';
import {
  createDashboardService,
  createItemsService,
  createItineraryService,
  createTripsService,
  createUnitsService,
  writePath,
} from '@tribo/core';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { membersService } from './invite-world.js';
import { testKeys } from './keys.js';
import { buildWorld, leakRunOptions, oracle, worldArb, type BuiltWorld } from './leak.js';

const options = leakRunOptions();
// Each world is committed and then written to, so fewer of them than the read-only properties.
const runs = { ...options, numRuns: Math.max(10, Math.floor(options.numRuns / 4)) };

/** A read that refuses outsiders with not_found: what it shows, or nothing. */
async function orNothing<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') return [];
    throw error;
  }
}

/** Everything each account reads of the world's trips: items, boards, members, itinerary, dashboard. */
async function readsOf(db: Kysely<DB>, world: BuiltWorld, userId: string): Promise<string[]> {
  const items = createItemsService(db, writePath(db), testKeys());
  const units = createUnitsService(db, writePath(db));
  const members = membersService(db);
  const itinerary = createItineraryService(db);
  const dashboard = createDashboardService(db, { trips: createTripsService(db, writePath(db)) });
  const seen: string[] = [];
  for (const trip of world.trips) {
    /* eslint-disable no-await-in-loop -- one read at a time keeps failures readable */
    const page = { limit: PAGE_LIMIT_MAX };
    seen.push(
      ...(await orNothing(async () =>
        (await items.list(userId, trip.id, page)).items.map((i) => `item:${i.id}`),
      )),
      ...(await orNothing(async () =>
        (await members.list(userId, trip.id, page)).items.map((m) => `member:${m.id}`),
      )),
      ...(await orNothing(async () =>
        (await itinerary.get(userId, trip.id, { view: 'group' })).items.map(
          (i) => `itinerary:${i.id}`,
        ),
      )),
      ...(await orNothing(async () => [
        `dashboard:${(await dashboard.get(userId, trip.id)).tripId}`,
      ])),
    );
    for (const item of trip.items) {
      seen.push(
        ...(await orNothing(async () =>
          (await units.board(userId, item.id)).allocations.map(
            (a) => `board:${item.id}:${a.membershipId}:${a.role}`,
          ),
        )),
      );
    }
    /* eslint-enable no-await-in-loop */
  }
  return seen.sort();
}

/** What the oracle lets the account read of the world. */
function allowed(world: BuiltWorld, userId: string): string[] {
  return world.trips
    .flatMap((t) => [
      ...t.items.filter((i) => oracle.itemVisible(world, userId, i.id)).map((i) => `item:${i.id}`),
      ...t.members
        .filter((m) => oracle.memberVisible(world, userId, m.id))
        .map((m) => `member:${m.id}`),
      ...t.items
        .filter((i) => oracle.itemVisible(world, userId, i.id))
        .flatMap((i) => i.allocations.map((a) => `board:${i.id}:${a.membershipId}:${a.role}`)),
      ...t.items
        .filter((i) => i.dated && oracle.itemVisible(world, userId, i.id))
        .map((i) => `itinerary:${i.id}`),
      ...(oracle.tripVisible(world, userId, t.id) ? [`dashboard:${t.id}`] : []),
    ])
    .sort();
}

/** The world as the removal leaves it: the membership gone, its board rows and private items too. */
function afterRemoval(world: BuiltWorld, tripId: string, membershipId: string): BuiltWorld {
  return {
    ...world,
    trips: world.trips.map((t) =>
      t.id !== tripId
        ? t
        : {
            ...t,
            members: t.members.map((m) => (m.id === membershipId ? { ...m, deleted: true } : m)),
            items: t.items.map((i) => ({
              ...i,
              deleted:
                i.deleted || (i.ownerMembershipId === membershipId && i.visibility === 'private'),
              allocations: i.allocations.filter((a) => a.membershipId !== membershipId),
            })),
          },
    ),
  };
}

describe('members.remove against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it(`hides the trip from the removed member and their private items from everyone (seed ${String(runs.seed)}, ${String(runs.numRuns)} worlds)`, async () => {
    const members = membersService(tdb.db);
    let n = 0;
    await fc.assert(
      fc.asyncProperty(worldArb, fc.nat(), async (spec, pick) => {
        const built = await buildWorld(tdb.db, spec);
        const removable = built.trips
          .filter((t) => !t.deleted)
          .flatMap((t) =>
            t.members.filter((m) => m.role !== 'owner' && !m.deleted).map((m) => ({ t, m })),
          );
        const target = removable[pick % Math.max(1, removable.length)];
        if (!target) return;
        const ownerPerson = target.t.members.find((m) => m.role === 'owner')?.personId;
        const owner = built.persons.find((p) => p.id === ownerPerson)?.userId;
        if (!owner) throw new Error('a trip without its owner account');
        n += 1;
        await members.remove(
          { requestId: `leak-remove-${String(n)}`, surface: 'web', userId: owner },
          target.t.id,
          target.m.id,
          undefined,
          1,
        );
        const world = afterRemoval(built, target.t.id, target.m.id);
        // The removed member, if an account, reads nothing of the trip they left.
        const removed = built.persons.find((p) => p.id === target.m.personId)?.userId;
        if (removed) {
          const theirs = await readsOf(tdb.db, world, removed);
          const ofTrip = [...target.t.items.map((i) => i.id), ...target.t.members.map((m) => m.id)];
          const leaked = theirs.filter((r) => ofTrip.some((id) => r.includes(id)));
          if (leaked.length > 0)
            throw new Error(`a removed member still reads ${leaked.join(', ')}`);
        }
        for (const userId of world.userIds) {
          // eslint-disable-next-line no-await-in-loop -- one account at a time
          const seen = await readsOf(tdb.db, world, userId);
          const expected = allowed(world, userId);
          if (JSON.stringify(seen) !== JSON.stringify(expected)) {
            throw new Error(
              `after members.remove, ${userId} read ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}`,
            );
          }
        }
      }),
      runs,
    );
  });
});
