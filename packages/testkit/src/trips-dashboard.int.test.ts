// @module-tag drop-a
// trips.dashboard (Drop A): Countdown, next item, open tasks, due soon, my share (sum of my expense shares; no balance or who-owes-whom, R36), warnings; Costs masked for viewers w/o canViewCosts; Poll with If-None-Match on the representation ETag (rule 4)
import { createDashboardService, type DashboardService } from '@tribo/core';
import type { DB } from '@tribo/db';
import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardWorld, refusal, type Member } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createExpense, createItem, softDelete } from './factories.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

/** The dashboard as read at one instant. */
function dashboardAt(iso: string): DashboardService {
  return createDashboardService(tdb.db, {
    now: () => new Date(iso),
  });
}

/** 9 Nov 2026, 10:00 in Manila: two days before the trip of boardWorld (11–14 Nov). */
let before: DashboardService;
beforeAll(() => {
  before = dashboardAt('2026-11-09T02:00:00Z');
});

type World = Awaited<ReturnType<typeof boardWorld>>;

const manila = (local: string) => ({ start: new Date(`${local}:00+08:00`), tz: 'Asia/Manila' });

function task(w: World, init: { owner?: Member; days?: { start: string }; status?: 'done' }) {
  return createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: (init.owner ?? w.owner).membershipId,
    type: 'task',
    ...(init.days ? { days: init.days } : {}),
    ...(init.status ? { status: init.status } : {}),
  });
}

const assign = (w: World, itemId: string, m: Member) =>
  addAllocation(tdb.db, {
    tripId: w.tripId,
    itemId,
    membershipId: m.membershipId,
    role: 'assignee',
  });

describe('trips.dashboard', () => {
  it('counts down to the trip by today in its zone, then says it is underway and over', async () => {
    const w = await boardWorld(tdb);
    const countdown = async (iso: string) =>
      (await dashboardAt(iso).get(w.member.userId, w.tripId)).countdown;
    expect(await countdown('2026-11-09T02:00:00Z')).toEqual({
      startDate: '2026-11-11',
      endDate: '2026-11-14',
      timezone: 'Asia/Manila',
      daysToStart: 2,
      phase: 'upcoming',
    });
    // 10 Nov 16:30 UTC is already 11 Nov in Manila.
    expect(await countdown('2026-11-10T16:30:00Z')).toMatchObject({
      daysToStart: 0,
      phase: 'underway',
    });
    expect(await countdown('2026-11-15T01:00:00Z')).toMatchObject({
      daysToStart: 0,
      phase: 'over',
    });
  });

  it('names the next item to start: not a task, not cancelled, not one already begun', async () => {
    const w = await boardWorld(tdb);
    const at = (local: string, init: { type?: 'task'; status?: 'cancelled' } = {}) =>
      createItem(tdb.db, {
        tripId: w.tripId,
        ownerMembershipId: w.owner.membershipId,
        timed: manila(local),
        ...init,
      });
    await at('2026-11-09T09:00'); // already begun at 10:00
    await at('2026-11-09T11:00', { type: 'task' });
    await at('2026-11-09T11:30', { status: 'cancelled' });
    const ferry = await at('2026-11-09T12:00');
    await at('2026-11-09T13:00');
    expect((await before.get(w.member.userId, w.tripId)).nextItem?.id).toBe(ferry);

    // Later, the lodging (all-day, 11 Nov) is the next thing ahead.
    const later = dashboardAt('2026-11-10T02:00:00Z');
    expect((await later.get(w.member.userId, w.tripId)).nextItem?.id).toBe(w.lodging);
    const after = dashboardAt('2026-12-01T00:00:00Z');
    expect((await after.get(w.member.userId, w.tripId)).nextItem).toBeNull();
  });

  it('lists the caller’s open tasks by due date, and those due within 7 days as due soon', async () => {
    const w = await boardWorld(tdb);
    const soon = await task(w, { days: { start: '2026-11-10' } });
    const overdue = await task(w, { days: { start: '2026-11-01' } });
    const later = await task(w, { days: { start: '2026-11-30' } });
    const undated = await task(w, { owner: w.member });
    const done = await task(w, { days: { start: '2026-11-10' }, status: 'done' });
    const theirs = await task(w, { days: { start: '2026-11-10' } });
    const ownedButAssigned = await task(w, { owner: w.member, days: { start: '2026-11-10' } });
    for (const id of [soon, overdue, later, done]) await assign(w, id, w.member); // eslint-disable-line no-await-in-loop
    await assign(w, theirs, w.other);
    await assign(w, ownedButAssigned, w.other);

    const dash = await before.get(w.member.userId, w.tripId);
    expect(dash.openTasks.map((t) => t.id)).toEqual([overdue, soon, later, undated]);
    expect(dash.dueSoon.map((d) => [d.kind, d.item.id])).toEqual([
      ['task_due', overdue],
      ['task_due', soon],
    ]);
  });

  it('sums the caller’s shares of the expenses not voided, zero with none, as the trip currency', async () => {
    const w = await boardWorld(tdb);
    const share = async (m: Member) => (await before.get(m.userId, w.tripId)).myShare;
    expect(await share(w.member)).toEqual({ amountMinor: 0, currency: 'PHP' });
    const split = (shares: [Member, number][], voided = false) =>
      createExpense(tdb.db, {
        tripId: w.tripId,
        payerMembershipId: w.owner.membershipId,
        shares: shares.map(([m, amount]) => ({ membershipId: m.membershipId, amount })),
        voided,
      });
    await split([
      [w.member, 125_050],
      [w.other, 125_050],
    ]);
    await split([[w.member, 30_000]]);
    await split([[w.member, 99_999]], true);
    expect(await share(w.member)).toEqual({ amountMinor: 155_050, currency: 'PHP' });
    // The payer paid everything and shares in nothing: no balance, no who-owes-whom (R36).
    expect(await share(w.owner)).toEqual({ amountMinor: 0, currency: 'PHP' });
  });

  it('masks my share and item costs for a viewer without the grant, zero or not', async () => {
    const w = await boardWorld(tdb);
    const ferry = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      timed: manila('2026-11-09T12:00'),
      cost: { amountMinor: 80_000, currency: 'PHP' },
    });
    const viewer = await before.get(w.viewer.userId, w.tripId);
    expect(viewer.myShare).toBe('masked');
    expect(viewer.nextItem).toMatchObject({ id: ferry, cost: 'masked' });
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ can_view_costs: true })
      .where('id', '=', w.viewer.membershipId)
      .execute();
    const granted = await before.get(w.viewer.userId, w.tripId);
    expect(granted.myShare).toEqual({ amountMinor: 0, currency: 'PHP' });
    expect(granted.nextItem?.cost).toEqual({ amountMinor: 80_000, currency: 'PHP' });
  });

  it('shows the group itinerary’s warnings, and nothing of an item the caller cannot see', async () => {
    const w = await boardWorld(tdb);
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.rental,
      membershipId: w.other.membershipId,
      role: 'driver',
      unitId: w.bike,
    });
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
      timed: manila('2026-11-09T11:00'),
    });
    const secretTask = await task(w, { owner: w.other, days: { start: '2026-11-10' } });
    await tdb.db
      .updateTable('tribo.items')
      .set({ visibility: 'private' })
      .where('id', '=', secretTask)
      .execute();
    await assign(w, secretTask, w.member);

    const mine = await before.get(w.member.userId, w.tripId);
    expect(mine.warnings).toEqual([
      { code: 'no_licensed_driver', itemId: w.rental, unitId: w.bike },
    ]);
    expect(mine.nextItem?.id).toBe(w.lodging);
    expect(JSON.stringify(mine)).not.toContain(secret);
    expect(JSON.stringify(mine)).not.toContain(secretTask);
    expect((await before.get(w.other.userId, w.tripId)).nextItem?.id).toBe(secret);
  });

  it('lets owner, organizer, member and viewer read it', async () => {
    const w = await boardWorld(tdb);
    for (const user of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      await expect(before.get(user.userId, w.tripId)).resolves.toMatchObject({
        tripId: w.tripId,
      });
    }
  });

  it('answers not_found outside the trip, to a removed member and on a deleted trip', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(before.get(w.outsider.userId, w.tripId))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.other.membershipId);
    expect(await refusal(before.get(w.other.userId, w.tripId))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(before.get(w.owner.userId, w.tripId))).toBe('not_found');
  });
});

describe('trips.dashboard on a representative trip', () => {
  /** A trip of `items` items, some private, some tasks, half of them on someone's board. */
  async function bigTrip(items: number) {
    const w = await boardWorld(tdb);
    const crew = [w.owner, w.organizer, w.member, w.other, w.viewer];
    for (let i = 0; i < items; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- rows go in one by one
      const id = await createItem(tdb.db, {
        tripId: w.tripId,
        ownerMembershipId: (crew[i % crew.length] ?? w.owner).membershipId,
        type: i % 5 === 0 ? 'task' : 'activity',
        visibility: i % 7 === 0 ? 'private' : 'shared',
        days: { start: `2026-11-${String(10 + (i % 5))}` },
        cost: { amountMinor: 1_000 * i, currency: 'PHP' },
      });
      // eslint-disable-next-line no-await-in-loop -- as above
      if (i % 2 === 0) await assign(w, id, crew[(i + 1) % crew.length] ?? w.member);
    }
    await createExpense(tdb.db, {
      tripId: w.tripId,
      payerMembershipId: w.owner.membershipId,
      shares: crew.map((m) => ({ membershipId: m.membershipId, amount: 10_000 })),
    });
    return w;
  }

  /** The number of queries one read sends, through a handle that counts them. */
  async function queriesOf(read: (db: Kysely<DB>) => Promise<unknown>): Promise<number> {
    let queries = 0;
    // Same pool as the test database; never destroyed here, so the pool stays open.
    const counted = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: tdb.pool }),
      log: (event) => {
        if (event.level === 'query') queries += 1;
      },
    });
    await read(counted);
    return queries;
  }

  it('sends the same number of queries for 10 items as for 300 (no N+1)', async () => {
    const small = await bigTrip(10);
    const large = await bigTrip(300);
    const read = (w: World) => (db: Kysely<DB>) =>
      createDashboardService(db, {
        now: () => new Date('2026-11-09T02:00:00Z'),
      }).get(w.member.userId, w.tripId);
    expect(await queriesOf(read(large))).toBe(await queriesOf(read(small)));
  });

  // A measured run, not a CI gate: timings under a loaded parallel suite say little. Run it
  // alone with TRIBO_MEASURE=1 (the pull request quotes its numbers).
  it.runIf(process.env.TRIBO_MEASURE === '1')(
    'answers 300 items well under the 300 ms read target',
    async () => {
      const w = await bigTrip(300);
      await before.get(w.member.userId, w.tripId); // warm the pool and the plans
      const runs: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop -- timed one at a time
        await before.get(w.member.userId, w.tripId);
        runs.push(performance.now() - started);
      }
      runs.sort((x, y) => x - y);
      const [median = Infinity, slowest = Infinity] = [runs[10], runs.at(-1)];
      // eslint-disable-next-line no-console -- the measured run's whole point is to print its numbers
      console.info(
        `trips.dashboard, 300 items: median ${median.toFixed(1)} ms, slowest ${slowest.toFixed(1)} ms`,
      );
      expect(slowest).toBeLessThan(300);
    },
  );
});
