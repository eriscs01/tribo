// @module-tag drop-b
// me.tasks (Drop B): "My trip" tasks across trips + due-soon reminders; item_visible per trip; overlay reminders are own only
// Through the my-tasks service and the real trips, items and itinerary modules: the caller's
// open tasks across the trips they are in, the due-soon list of task due dates and their own
// reminders, and nothing of trips they left, trips deleted or archived, items they cannot see
// or overlays that are not theirs.
import { createMyTasksService, type MyTasksService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createOverlay,
  createTrip,
  createUser,
  softDelete,
  type TripRole,
  type UserFixture,
} from './factories.js';

let tdb: TestDatabase;
let myTasks: MyTasksService;
/** 9 Nov 2026, 10:00 in Manila. */
const NOW = new Date('2026-11-09T02:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

beforeAll(async () => {
  tdb = await createTestDatabase();
  myTasks = createMyTasksService(tdb.db, { now: () => NOW });
});
afterAll(async () => {
  await tdb.destroy();
});

/** A trip the caller is in as `role`, owned by someone else, and the caller's membership in it. */
async function tripFor(caller: UserFixture, role: TripRole, name = 'Siargao') {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner, name });
  const membershipId = await addMember(tdb.db, {
    tripId: trip.tripId,
    personId: caller.personId,
    role,
  });
  return { ...trip, owner, membershipId };
}

type Trip = Awaited<ReturnType<typeof tripFor>>;

/** A task on a trip, owned by the trip owner unless `owner` says otherwise. */
function taskOn(
  trip: Trip,
  init: {
    owner?: string;
    due?: string;
    status?: 'done' | 'cancelled';
    visibility?: 'private';
    assignee?: string;
  } = {},
) {
  return createItem(tdb.db, {
    tripId: trip.tripId,
    ownerMembershipId: init.owner ?? trip.ownerMembershipId,
    type: 'task',
    ...(init.due ? { days: { start: init.due } } : {}),
    ...(init.status ? { status: init.status } : {}),
    ...(init.visibility ? { visibility: init.visibility } : {}),
  }).then(async (id) => {
    if (init.assignee) {
      await addAllocation(tdb.db, {
        tripId: trip.tripId,
        itemId: id,
        membershipId: init.assignee,
        role: 'assignee',
      });
    }
    return id;
  });
}

describe('me.tasks', () => {
  it('lists the caller’s open tasks across their trips, by due date, with the trip each is in', async () => {
    const me = await createUser(tdb.db);
    const a = await tripFor(me, 'member', 'Siargao');
    const b = await tripFor(me, 'organizer', 'Bohol');
    const lateA = await taskOn(a, { due: '2026-12-01', assignee: a.membershipId });
    const soonB = await taskOn(b, { due: '2026-11-10', assignee: b.membershipId });
    const ownedA = await taskOn(a, { owner: a.membershipId });
    const result = await myTasks.get(me.userId);
    expect(result.tasks.map((t) => [t.tripName, t.item.id])).toEqual([
      ['Bohol', soonB],
      ['Siargao', lateA],
      ['Siargao', ownedA],
    ]);
    expect(result.tasks[0]?.item.tripId).toBe(b.tripId);
  });

  it('counts a task assigned to the caller, or owned by them with nobody assigned; not done, cancelled or others’', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const mine = await taskOn(t, { assignee: t.membershipId });
    const owned = await taskOn(t, { owner: t.membershipId });
    await taskOn(t, { owner: t.membershipId, assignee: t.ownerMembershipId });
    await taskOn(t, { assignee: t.membershipId, status: 'done' });
    await taskOn(t, { assignee: t.membershipId, status: 'cancelled' });
    await taskOn(t, { assignee: t.ownerMembershipId });
    await taskOn(t);
    expect((await myTasks.get(me.userId)).tasks.map((x) => x.item.id).sort()).toEqual(
      [mine, owned].sort(),
    );
  });

  it('names no task the caller cannot see, though it is assigned to them', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    await taskOn(t, { visibility: 'private', assignee: t.membershipId });
    const shown = await taskOn(t, { assignee: t.membershipId });
    expect((await myTasks.get(me.userId)).tasks.map((x) => x.item.id)).toEqual([shown]);
  });

  it('leaves out trips the caller left, trips deleted or archived, and items deleted', async () => {
    const me = await createUser(tdb.db);
    const kept = await tripFor(me, 'member', 'Kept');
    const left = await tripFor(me, 'member', 'Left');
    const gone = await tripFor(me, 'member', 'Gone');
    const old = await tripFor(me, 'member', 'Old');
    const removed = await taskOn(kept, { assignee: kept.membershipId });
    const shown = await taskOn(kept, { assignee: kept.membershipId });
    for (const t of [left, gone, old]) await taskOn(t, { assignee: t.membershipId }); // eslint-disable-line no-await-in-loop
    await softDelete(tdb.db, 'tribo.items', removed);
    await softDelete(tdb.db, 'tribo.memberships', left.membershipId);
    await softDelete(tdb.db, 'tribo.trips', gone.tripId);
    await archive(tdb, old.tripId);
    expect((await myTasks.get(me.userId)).tasks.map((x) => x.item.id)).toEqual([shown]);
  });

  it('lists a task in every role the caller holds but owner, a viewer’s included, masking its cost as the trip does', async () => {
    const me = await createUser(tdb.db);
    const trips = await Promise.all(
      (['organizer', 'member', 'viewer'] as const).map((role) => tripFor(me, role, role)),
    );
    for (const t of trips) {
      // eslint-disable-next-line no-await-in-loop -- one setup at a time
      const id = await createItem(tdb.db, {
        tripId: t.tripId,
        ownerMembershipId: t.ownerMembershipId,
        type: 'task',
        cost: { amountMinor: 123_456, currency: 'PHP' },
      });
      // eslint-disable-next-line no-await-in-loop -- as above
      await addAllocation(tdb.db, {
        tripId: t.tripId,
        itemId: id,
        membershipId: t.membershipId,
        role: 'assignee',
      });
    }
    const result = await myTasks.get(me.userId);
    expect(result.tasks.map((t) => t.tripName).sort()).toEqual(['member', 'organizer', 'viewer']);
    const costs = Object.fromEntries(result.tasks.map((t) => [t.tripName, t.item.cost]));
    expect(costs.viewer).toBe('masked');
    expect(costs.member).toEqual({ amountMinor: 123_456, currency: 'PHP' });
  });

  it('answers an empty list to an account with no trips or tasks', async () => {
    const me = await createUser(tdb.db);
    expect(await myTasks.get(me.userId)).toEqual({ tasks: [], dueSoon: [] });
    await tripFor(me, 'member');
    expect(await myTasks.get(me.userId)).toEqual({ tasks: [], dueSoon: [] });
  });

  it('lists tasks due within 7 days, overdue ones too, in the trip’s own day, as due soon', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const overdue = await taskOn(t, { due: '2026-11-01', assignee: t.membershipId });
    const edge = await taskOn(t, { due: '2026-11-16', assignee: t.membershipId });
    await taskOn(t, { due: '2026-11-17', assignee: t.membershipId });
    await taskOn(t, { assignee: t.membershipId });
    expect((await myTasks.get(me.userId)).dueSoon.map((d) => [d.kind, d.item.id])).toEqual([
      ['task_due', overdue],
      ['task_due', edge],
    ]);
  });

  it('adds the caller’s own reminders within 7 days of now, either way, on items they see', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const remind = async (reminderAt: Date | null, itemId?: string) => {
      const id =
        itemId ??
        (await createItem(tdb.db, { tripId: t.tripId, ownerMembershipId: t.ownerMembershipId }));
      await createOverlay(tdb.db, {
        tripId: t.tripId,
        itemId: id,
        membershipId: t.membershipId,
        note: 'for me',
        reminderAt,
      });
      return id;
    };
    const soon = await remind(day(3));
    const past = await remind(day(-3));
    await remind(day(30));
    await remind(day(-10));
    await remind(null);
    const result = await myTasks.get(me.userId);
    expect(result.dueSoon.map((d) => d.kind === 'reminder' && [d.item.id, d.reminderAt])).toEqual([
      [past, day(-3)],
      [soon, day(3)],
    ]);
    expect(result.tasks).toEqual([]);
  });

  it('shows a reminder on a task beside the task’s own due entry', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const task = await taskOn(t, { due: '2026-11-10', assignee: t.membershipId });
    await createOverlay(tdb.db, {
      tripId: t.tripId,
      itemId: task,
      membershipId: t.membershipId,
      reminderAt: day(1),
    });
    expect((await myTasks.get(me.userId)).dueSoon.map((d) => [d.kind, d.item.id])).toEqual([
      ['task_due', task],
      ['reminder', task],
    ]);
  });

  it('never shows another member’s reminder, nor a reminder on an item the caller cannot see', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const shared = await createItem(tdb.db, {
      tripId: t.tripId,
      ownerMembershipId: t.ownerMembershipId,
    });
    const hidden = await createItem(tdb.db, {
      tripId: t.tripId,
      ownerMembershipId: t.ownerMembershipId,
      visibility: 'private',
    });
    await createOverlay(tdb.db, {
      tripId: t.tripId,
      itemId: shared,
      membershipId: t.ownerMembershipId,
      reminderAt: day(1),
    });
    await createOverlay(tdb.db, {
      tripId: t.tripId,
      itemId: hidden,
      membershipId: t.membershipId,
      reminderAt: day(1),
    });
    expect((await myTasks.get(me.userId)).dueSoon).toEqual([]);
  });

  it('shows no reminder of a viewer, a removed member or a deleted trip, or on a deleted item', async () => {
    const me = await createUser(tdb.db);
    const viewer = await tripFor(me, 'viewer', 'Viewer');
    const left = await tripFor(me, 'member', 'Left');
    const gone = await tripFor(me, 'member', 'Gone');
    const dead = await tripFor(me, 'member', 'Dead');
    const items: Trip[] = [viewer, left, gone, dead];
    for (const t of items) {
      // eslint-disable-next-line no-await-in-loop -- one setup at a time
      const id = await createItem(tdb.db, {
        tripId: t.tripId,
        ownerMembershipId: t.ownerMembershipId,
      });
      // eslint-disable-next-line no-await-in-loop -- as above
      await createOverlay(tdb.db, {
        tripId: t.tripId,
        itemId: id,
        membershipId: t.membershipId,
        reminderAt: day(1),
      });
      if (t === dead) {
        // eslint-disable-next-line no-await-in-loop -- as above
        await softDelete(tdb.db, 'tribo.items', id);
      }
    }
    await softDelete(tdb.db, 'tribo.memberships', left.membershipId);
    await softDelete(tdb.db, 'tribo.trips', gone.tripId);
    expect((await myTasks.get(me.userId)).dueSoon).toEqual([]);
  });

  it('shows no reminder that was removed with its overlay', async () => {
    const me = await createUser(tdb.db);
    const t = await tripFor(me, 'member');
    const id = await createItem(tdb.db, {
      tripId: t.tripId,
      ownerMembershipId: t.ownerMembershipId,
    });
    await createOverlay(tdb.db, {
      tripId: t.tripId,
      itemId: id,
      membershipId: t.membershipId,
      reminderAt: day(1),
      deleted: true,
    });
    expect((await myTasks.get(me.userId)).dueSoon).toEqual([]);
  });
});
