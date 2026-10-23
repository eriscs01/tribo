// @module-tag drop-b
// me.tasks against the oracle: for every account, the open tasks it lists are exactly those
// of its own that it may see in the trips it is in; its due-soon reminders are exactly the
// ones it set itself, on items it sees, as a member who is not a viewer; and nothing it reads
// changes, or costs a query more, with every other member's overlay gone or every item hidden
// from it gone.
/* eslint-disable no-await-in-loop -- one transaction, so one statement at a time */
import { createMyTasksService, type MyTasksRecord } from '@tribo/core';
import type { DB } from '@tribo/db';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  leakRunOptions,
  oracle,
  withoutHiddenItems,
  worldProperty,
  type BuiltWorld,
} from './leak.js';
import {
  activeMembership,
  counted,
  SEEDED_NOW,
  seededReminder,
  seedOverlays,
} from './overlays-world.js';

const options = leakRunOptions();

type MyTasksRead = (db: Kysely<DB>, userId: string) => Promise<MyTasksRecord>;

const readMyTasks: MyTasksRead = (db, userId) =>
  createMyTasksService(db, { now: () => SEEDED_NOW }).get(userId);

/** The tasks the oracle says an account has to do: visible, open, assigned to them or owned with nobody assigned. */
function expectedTasks(world: BuiltWorld, userId: string): string[] {
  return world.trips
    .flatMap((trip) => {
      const mine = activeMembership(world, userId, trip.id);
      if (!mine || trip.deleted) return [];
      return trip.items.filter((item) => {
        if (item.type !== 'task' || item.done || !oracle.itemVisible(world, userId, item.id)) {
          return false;
        }
        const assignees = item.allocations.filter((a) => a.role === 'assignee');
        return (
          assignees.some((a) => a.membershipId === mine.id) ||
          (item.ownerMembershipId === mine.id && assignees.length === 0)
        );
      });
    })
    .map((item) => item.id)
    .sort();
}

/** The reminders the oracle says an account set itself and may see: [item id, time]. */
function expectedReminders(world: BuiltWorld, userId: string): string[] {
  return world.trips
    .flatMap((trip) => {
      const mine = activeMembership(world, userId, trip.id);
      if (!mine || mine.role === 'viewer') return [];
      return trip.items
        .filter((item) => oracle.itemVisible(world, userId, item.id))
        .map((item) => `${item.id}@${seededReminder(world, mine.id).toISOString()}`);
    })
    .sort();
}

/** What an account's me.tasks read named wrongly, against the oracle. */
function leaks(world: BuiltWorld, userId: string, read: MyTasksRecord): string[] {
  const problems: string[] = [];
  const tasks = read.tasks.map((t) => t.item.id).sort();
  if (JSON.stringify(tasks) !== JSON.stringify(expectedTasks(world, userId))) {
    problems.push(`${userId} lists tasks ${JSON.stringify(tasks)}`);
  }
  const reminders = read.dueSoon
    .flatMap((d) => (d.kind === 'reminder' ? [`${d.item.id}@${d.reminderAt.toISOString()}`] : []))
    .sort();
  if (JSON.stringify(reminders) !== JSON.stringify(expectedReminders(world, userId))) {
    problems.push(`${userId} lists reminders ${JSON.stringify(reminders)}`);
  }
  for (const due of read.dueSoon.filter((d) => d.kind === 'task_due')) {
    if (!tasks.includes(due.item.id))
      problems.push(`${userId}: due task ${due.item.id} is not theirs`);
  }
  for (const { item } of [...read.tasks, ...read.dueSoon]) {
    if (
      item.cost !== null &&
      item.cost !== 'masked' &&
      !oracle.moneyReadable(world, userId, item.id)
    ) {
      problems.push(`${userId} reads the cost of ${item.id}`);
    }
  }
  return problems;
}

describe('me.tasks against the oracle', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  const listsOnlyWhatIsTheirs = (read: MyTasksRead) =>
    worldProperty(tdb.db, async (trx, world) => {
      await seedOverlays(trx, world);
      const problems: string[] = [];
      for (const userId of world.userIds) {
        problems.push(...leaks(world, userId, await read(trx, userId)));
      }
      return problems;
    });

  it(`lists only the caller’s own tasks and reminders (seed ${String(options.seed)}, ${String(options.numRuns)} worlds)`, async () => {
    await fc.assert(listsOnlyWhatIsTheirs(readMyTasks), options);
  });

  it('reads the same, at the same cost, with every item hidden from the caller gone', async () => {
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedOverlays(trx, world);
        const problems: string[] = [];
        for (const userId of world.userIds) {
          const { before, after } = await withoutHiddenItems(trx, world, userId, async () => {
            const { handle, state } = counted(trx);
            const read = await readMyTasks(handle, userId);
            return JSON.stringify({ read, queries: state.queries });
          });
          if (before !== after) problems.push(`${userId}'s tasks change with hidden items`);
        }
        return problems;
      }),
      options,
    );
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
              read: await readMyTasks(handle, userId),
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
              problems.push(`${userId}'s read changes with others' overlays`);
          } finally {
            await sql`ROLLBACK TO SAVEPOINT without_others`.execute(trx);
          }
        }
        return problems;
      }),
      options,
    );
  });

  it('mutation check: the harness catches a read that adds every member’s reminder', async () => {
    const leaky: MyTasksRead = async (db, userId) => {
      const fair = await readMyTasks(db, userId);
      const first = fair.tasks[0]?.item ?? fair.dueSoon[0]?.item;
      const others = await db
        .selectFrom('tribo.overlays')
        .select(['item_id', 'reminder_at'])
        .where('reminder_at', 'is not', null)
        .execute();
      const item = first;
      if (!item) return fair;
      return {
        ...fair,
        dueSoon: [
          ...fair.dueSoon,
          ...others.map((o) => ({
            kind: 'reminder' as const,
            item: { ...item, id: o.item_id },
            reminderAt: o.reminder_at ?? new Date(0),
          })),
        ],
      };
    };
    expect((await fc.check(listsOnlyWhatIsTheirs(leaky), options)).failed).toBe(true);
  });

  it('mutation check: the harness catches a read that lists tasks of items hidden from the caller', async () => {
    const leaky: MyTasksRead = async (db, userId) => {
      const fair = await readMyTasks(db, userId);
      const hidden = await db
        .selectFrom('tribo.items')
        .select('id')
        .where('type', '=', 'task')
        .where('visibility', '=', 'private')
        .where('deleted_at', 'is', null)
        .execute();
      const sample = fair.tasks[0];
      if (!sample) return fair;
      return {
        ...fair,
        tasks: [
          ...fair.tasks,
          ...hidden.map((h) => ({ ...sample, item: { ...sample.item, id: h.id } })),
        ],
      };
    };
    expect((await fc.check(listsOnlyWhatIsTheirs(leaky), options)).failed).toBe(true);
  });

  it('is the real thing: an account with tasks gets some, so the properties are not vacuous', async () => {
    let seen = 0;
    await fc.assert(
      worldProperty(tdb.db, async (trx, world) => {
        await seedOverlays(trx, world);
        for (const userId of world.userIds) {
          const read = await readMyTasks(trx, userId);
          seen += read.tasks.length + read.dueSoon.length;
        }
        return [];
      }),
      options,
    );
    expect(seen).toBeGreaterThan(0);
  });
});
