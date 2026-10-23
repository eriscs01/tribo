// @module-tag drop-b
// trips.dashboard (Drop B): the due-soon list gains the caller's own reminders (F-08)
// Through the dashboard service and the real trips, items and itinerary modules: a reminder
// the caller set on an item of the trip they see shows within 7 days of now, either side,
// beside the tasks that are due; another member's never does, and nor does one on a hidden
// item, from a viewer, or past its overlay.
import { createDashboardService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardWorld } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, createOverlay, softDelete } from './factories.js';

let tdb: TestDatabase;
/** 9 Nov 2026, 10:00 in Manila: two days before the trip of boardWorld. */
const NOW = new Date('2026-11-09T02:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);
const dashboard = () => createDashboardService(tdb.db, { now: () => NOW });

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

type World = Awaited<ReturnType<typeof boardWorld>>;

const remind = (w: World, who: { membershipId: string }, itemId: string, reminderAt: Date | null) =>
  createOverlay(tdb.db, { tripId: w.tripId, itemId, membershipId: who.membershipId, reminderAt });

describe('trips.dashboard reminders', () => {
  it('lists the caller’s own reminders within 7 days either side of now, soonest first, with their time', async () => {
    const w = await boardWorld(tdb);
    await remind(w, w.member, w.lodging, day(3));
    await remind(w, w.member, w.rental, day(-2));
    const far = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
    });
    await remind(w, w.member, far, day(8));
    const dash = await dashboard().get(w.member.userId, w.tripId);
    expect(dash.dueSoon.map((d) => d.kind === 'reminder' && [d.item.id, d.reminderAt])).toEqual([
      [w.rental, day(-2)],
      [w.lodging, day(3)],
    ]);
  });

  it('puts the tasks due before the reminders, and a task’s reminder beside the task', async () => {
    const w = await boardWorld(tdb);
    const task = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'task',
      days: { start: '2026-11-10' },
    });
    await remind(w, w.member, w.lodging, day(1));
    await remind(w, w.member, task, day(2));
    const dash = await dashboard().get(w.member.userId, w.tripId);
    expect(dash.dueSoon.map((d) => [d.kind, d.item.id])).toEqual([
      ['task_due', task],
      ['reminder', w.lodging],
      ['reminder', task],
    ]);
    expect(dash.openTasks.map((t) => t.id)).toEqual([task]);
  });

  it('never shows another member’s reminder, to the owner or to anyone', async () => {
    const w = await boardWorld(tdb);
    await remind(w, w.member, w.lodging, day(1));
    for (const who of [w.owner, w.organizer, w.other, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      expect((await dashboard().get(who.userId, w.tripId)).dueSoon).toEqual([]);
    }
  });

  it('shows no reminder on an item the caller cannot see, nor a removed overlay, nor a viewer’s', async () => {
    const w = await boardWorld(tdb);
    const hidden = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
    });
    await remind(w, w.member, hidden, day(1));
    await createOverlay(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      reminderAt: day(1),
      deleted: true,
    });
    await remind(w, w.viewer, w.lodging, day(1));
    await remind(w, w.owner, hidden, day(1));
    expect((await dashboard().get(w.member.userId, w.tripId)).dueSoon).toEqual([]);
    expect((await dashboard().get(w.viewer.userId, w.tripId)).dueSoon).toEqual([]);
    // The owner cannot see the other member's private item either.
    expect((await dashboard().get(w.owner.userId, w.tripId)).dueSoon).toEqual([]);
    await softDelete(tdb.db, 'tribo.items', w.rental);
  });

  it('keeps the next item, open tasks and my share as they were', async () => {
    const w = await boardWorld(tdb);
    const task = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'task',
    });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: task,
      membershipId: w.member.membershipId,
      role: 'assignee',
    });
    const without = await dashboard().get(w.member.userId, w.tripId);
    await remind(w, w.member, w.lodging, day(1));
    const withReminder = await dashboard().get(w.member.userId, w.tripId);
    expect({ ...withReminder, dueSoon: [] }).toEqual({ ...without, dueSoon: [] });
    expect(withReminder.dueSoon).toHaveLength(1);
  });
});
