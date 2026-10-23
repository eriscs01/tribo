// @module-tag drop-b
// trips.dashboard's reminders against the oracle: of the overlays every member of the world
// has on every item, an account's due-soon list holds exactly the reminders it set itself, on
// the items of that trip it sees, as a member who is not a viewer; and the dashboard reads the
// same, at the same cost, with every other member's overlay gone.
/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
import { createDashboardService, type DashboardRecord } from '@tribo/core';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { leakRunOptions, oracle, worldProperty, type BuiltWorld } from './leak.js';
import {
  activeMembership,
  counted,
  SEEDED_NOW,
  seededReminder,
  seedOverlays,
} from './overlays-world.js';

const options = leakRunOptions();

type DashboardRead = (db: Kysely<DB>, userId: string, tripId: string) => Promise<DashboardRecord>;

const readDashboard: DashboardRead = (db, userId, tripId) =>
  createDashboardService(db, { now: () => SEEDED_NOW }).get(userId, tripId);

/** The reminders of one trip the oracle says an account set itself and may see. */
function expectedReminders(world: BuiltWorld, userId: string, tripId: string): string[] {
  const trip = world.trips.find((t) => t.id === tripId);
  const mine = activeMembership(world, userId, tripId);
  if (!trip || !mine || mine.role === 'viewer') return [];
  return trip.items
    .filter((item) => oracle.itemVisible(world, userId, item.id))
    .map((item) => `${item.id}@${seededReminder(world, mine.id).toISOString()}`)
    .sort();
}

/** Every dashboard the account reads, by trip; the trips it is not in answer not_found. */
async function dashboardsOf(db: Kysely<DB>, world: BuiltWorld, userId: string) {
  const out: [string, DashboardRecord][] = [];
  for (const trip of world.trips) {
    try {
      out.push([trip.id, await readDashboard(db, userId, trip.id)]);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
  }
  return out;
}

describe('trips.dashboard reminders against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const listsOnlyItsOwn = (
    read: (db: Kysely<DB>, world: BuiltWorld, userId: string) => ReturnType<typeof dashboardsOf>,
  ) =>
    worldProperty(tdb.db, async (trx, world) => {
      await seedOverlays(trx, world);
      const problems: string[] = [];
      for (const userId of world.userIds) {
        for (const [tripId, d] of await read(trx, world, userId)) {
          const reminders = d.dueSoon
            .flatMap((s) =>
              s.kind === 'reminder' ? [`${s.item.id}@${s.reminderAt.toISOString()}`] : [],
            )
            .sort();
          if (
            JSON.stringify(reminders) !== JSON.stringify(expectedReminders(world, userId, tripId))
          ) {
            problems.push(`${userId} lists reminders ${JSON.stringify(reminders)} on ${tripId}`);
          }
        }
      }
      return problems;
    });

  it(`lists only the caller’s own reminders on items they see (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listsOnlyItsOwn(dashboardsOf), options);
  });

  it('reads the same, at the same cost, with every other member’s overlay gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedOverlays(trx, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const mine = world.trips
            .map((t) => activeMembership(world, userId, t.id)?.id)
            .filter((id): id is string => id !== undefined);
          const readAll = async () => {
            const { handle, state } = counted(trx);
            return JSON.stringify({
              dashboards: await dashboardsOf(handle, world, userId),
              queries: state.queries,
            });
          };
          const before = await readAll();
          await sql`SAVEPOINT without_others`.execute(trx);
          try {
            await trx
              .deleteFrom('tribo.overlays')
              .where(
                'membership_id',
                'not in',
                mine.length > 0 ? mine : ['00000000-0000-0000-0000-000000000000'],
              )
              .execute();
            if (before !== (await readAll()))
              problems.push(`${userId}'s dashboards change with others' overlays`);
          } finally {
            await sql`ROLLBACK TO SAVEPOINT without_others`.execute(trx);
          }
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a dashboard that lists every member’s reminders', async () => {
    const leaky: typeof dashboardsOf = async (db, world, userId) => {
      const fair = await dashboardsOf(db, world, userId);
      const others = await db
        .selectFrom('tribo.overlays')
        .select(['item_id', 'reminder_at', 'trip_id'])
        .where('reminder_at', 'is not', null)
        .execute();
      return fair.map(([tripId, d]) => {
        const sample = d.dueSoon[0]?.item ?? d.openTasks[0] ?? d.nextItem;
        if (!sample) return [tripId, d] as [string, DashboardRecord];
        return [
          tripId,
          {
            ...d,
            dueSoon: [
              ...d.dueSoon,
              ...others
                .filter((o) => o.trip_id === tripId)
                .map((o) => ({
                  kind: 'reminder' as const,
                  item: { ...sample, id: o.item_id },
                  reminderAt: o.reminder_at ?? new Date(0),
                })),
            ],
          },
        ] as [string, DashboardRecord];
      });
    };
    expect((await fc.check(listsOnlyItsOwn(leaky), options)).failed).toBe(true);
  });

  it('is the real thing: some dashboards list reminders, so the properties are not vacuous', async () => {
    let seen = 0;
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedOverlays(trx, world);
        for (const userId of world.userIds) {
          for (const [, d] of await dashboardsOf(trx, world, userId)) {
            seen += d.dueSoon.filter((s) => s.kind === 'reminder').length;
          }
        }
        return [];
      }),
      options,
    );
    expect(seen).toBeGreaterThan(0);
  });
});
