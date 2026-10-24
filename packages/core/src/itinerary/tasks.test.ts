import { describe, expect, it } from 'vitest';
import type { ItemRecord, TripItem } from '../items/service.js';
import { byWhen, dueSoon, openTasks, reminderWindow } from './tasks.js';

const AT = new Date('2026-11-09T02:00:00Z');

function item(id: string, init: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id,
    tripId: 't1',
    type: 'task',
    title: id,
    status: 'planned',
    start: null,
    end: null,
    visibility: 'shared',
    ownerMembershipId: 'someone',
    tags: [],
    cost: null,
    bookingRef: null,
    cardLast4: null,
    restrictedFields: [],
    version: 1,
    boardVersion: 1,
    createdAt: AT,
    updatedAt: AT,
    ...init,
  };
}

const allDay = (date: string) => ({ date });
const timed = (local: string, offset: string) => ({
  local,
  tz: 'Asia/Manila',
  at: new Date(`${local}:00${offset}`),
});

const withBoard = (i: ItemRecord, assignees: string[]): TripItem => ({
  item: i,
  board: assignees.map((membershipId) => ({
    membershipId,
    role: 'assignee',
    unitId: null,
    rsvp: null,
  })),
});

describe('openTasks', () => {
  it('keeps tasks assigned to the member, or owned by them with nobody assigned, by due date', () => {
    const items = [
      withBoard(item('late', { start: allDay('2026-12-01') }), ['me']),
      withBoard(item('soon', { start: allDay('2026-11-10') }), ['me', 'you']),
      withBoard(item('mine', { ownerMembershipId: 'me' }), []),
      withBoard(item('owned-but-given-away', { ownerMembershipId: 'me' }), ['you']),
      withBoard(item('yours', { start: allDay('2026-11-10') }), ['you']),
      withBoard(item('done', { status: 'done' }), ['me']),
      withBoard(item('cancelled', { status: 'cancelled' }), ['me']),
      withBoard(item('not-a-task', { type: 'activity' }), ['me']),
    ];
    expect(openTasks(items, 'me').map((t) => t.id)).toEqual(['soon', 'late', 'mine']);
  });
});

describe('byWhen', () => {
  it('orders by local day, all-day before timed, undated last, then by id', () => {
    const items = [
      item('c', { start: timed('2026-11-10T09:00', '+08:00') }),
      item('b', { start: allDay('2026-11-10') }),
      item('a', {}),
      item('d', { start: allDay('2026-11-09') }),
      item('a2', {}),
    ];
    expect([...items].sort(byWhen).map((i) => i.id)).toEqual(['d', 'b', 'c', 'a', 'a2']);
  });
});

describe('reminderWindow', () => {
  it('spans 7 days either side of now', () => {
    expect(reminderWindow(AT)).toEqual({
      from: new Date('2026-11-02T02:00:00Z'),
      to: new Date('2026-11-16T02:00:00Z'),
    });
  });
});

describe('dueSoon', () => {
  const today = () => '2026-11-09';

  it('lists tasks due by the seventh day from today, overdue ones too, then the reminders in order', () => {
    const tasks = [
      item('overdue', { start: allDay('2026-11-01') }),
      item('edge', { start: allDay('2026-11-16') }),
      item('beyond', { start: allDay('2026-11-17') }),
      item('undated'),
      item('timed-in', { start: timed('2026-11-15T09:00', '+08:00') }),
      item('timed-out', { start: timed('2026-11-17T09:00', '+08:00') }),
    ];
    const reminders = [
      { item: item('x', { type: 'activity' }), reminderAt: new Date('2026-11-10T00:00:00Z') },
      { item: item('y', { type: 'activity' }), reminderAt: new Date('2026-11-12T00:00:00Z') },
    ];
    expect(dueSoon(tasks, reminders, today).map((d) => [d.kind, d.item.id])).toEqual([
      ['task_due', 'overdue'],
      ['task_due', 'edge'],
      ['task_due', 'timed-in'],
      ['reminder', 'x'],
      ['reminder', 'y'],
    ]);
  });

  it('reads today in each task’s own trip', () => {
    const tasks = [
      item('here', { tripId: 'a', start: allDay('2026-11-12') }),
      item('there', { tripId: 'b', start: allDay('2026-11-12') }),
    ];
    const todays = (tripId: string) => (tripId === 'a' ? '2026-11-09' : '2026-10-01');
    expect(dueSoon(tasks, [], todays).map((d) => d.item.id)).toEqual(['here']);
  });

  it('compares a timed task’s local day with the last day, whichever side of midnight UTC it falls', () => {
    // Today is 9 Nov, so the last day is 16 Nov. 20:00 local that day is before midnight UTC
    // in Manila (12:00Z) and after it in Los Angeles (04:00Z on the 17th); both are due.
    const at = (local: string, tz: string, instant: string) => ({
      local,
      tz,
      at: new Date(instant),
    });
    const tasks = [
      item('manila-evening', {
        start: at('2026-11-16T20:00', 'Asia/Manila', '2026-11-16T12:00:00Z'),
      }),
      item('la-evening', {
        start: at('2026-11-16T20:00', 'America/Los_Angeles', '2026-11-17T04:00:00Z'),
      }),
      item('manila-after-midnight', {
        start: at('2026-11-17T00:30', 'Asia/Manila', '2026-11-16T16:30:00Z'),
      }),
      item('la-after-midnight', {
        start: at('2026-11-17T00:30', 'America/Los_Angeles', '2026-11-17T08:30:00Z'),
      }),
    ];
    expect(dueSoon(tasks, [], today).map((d) => d.item.id)).toEqual([
      'manila-evening',
      'la-evening',
    ]);
  });
});
