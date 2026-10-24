// What is the caller's to do, and what is due soon: pure rules over the items the caller can
// see and their own reminders. Shared by the trip dashboard and me.tasks, so the two never
// disagree. No database; whatever the items service hides never reaches here.
import type { ItemRecord, ReminderRecord, TripItem } from '../items/service.js';
import { addDays } from './timeline.js';

/** How far ahead a task counts as due soon, and how far either side of now a reminder does (Technical Design, "Reminders in 1a"). */
export const DUE_SOON_DAYS = 7;

/** Statuses after which an item is nothing to look forward to or to do. */
export const FINISHED = new Set<ItemRecord['status']>(['done', 'cancelled']);

/** One entry of a due-soon list: a task of the caller's that is due, or one of their own reminders. */
export type DueSoonRecord =
  { kind: 'task_due'; item: ItemRecord } | { kind: 'reminder'; item: ItemRecord; reminderAt: Date };

/**
 * An item's place in time for ordering: its local day, then all-day before timed, then the
 * instant. Undated items sort last.
 */
function when(item: ItemRecord): [string, number] {
  const { start } = item;
  if (start === null) return ['9999-12-31', Infinity];
  return 'date' in start ? [start.date, -Infinity] : [start.local.slice(0, 10), start.at.getTime()];
}

export function byWhen(a: ItemRecord, b: ItemRecord): number {
  const [[dayA, atA], [dayB, atB]] = [when(a), when(b)];
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  if (atA !== atB) return atA < atB ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * The caller's open tasks, by due date: tasks not done or cancelled that they are assigned
 * to, or that they own with nobody assigned. A task's due is its start until typed details
 * give it its own (decision 0012). `items` are one trip's, and `membershipId` the caller's in it.
 */
export function openTasks(items: readonly TripItem[], membershipId: string): ItemRecord[] {
  return items
    .filter(({ item, board }) => {
      if (item.type !== 'task' || FINISHED.has(item.status)) return false;
      const assignees = board.filter((r) => r.role === 'assignee');
      if (assignees.some((r) => r.membershipId === membershipId)) return true;
      return item.ownerMembershipId === membershipId && assignees.length === 0;
    })
    .map((i) => i.item)
    .sort(byWhen);
}

/** Whether a task is due on or before `lastDay` (a local day, overdue included). */
function isDueBy(task: ItemRecord, lastDay: string): boolean {
  const { start } = task;
  if (start === null) return false;
  return ('date' in start ? start.date : start.local.slice(0, 10)) <= lastDay;
}

/** The instants a reminder falls within to count as due soon: 7 days either side of now. */
export function reminderWindow(at: Date): { from: Date; to: Date } {
  const span = DUE_SOON_DAYS * 86_400_000;
  return { from: new Date(at.getTime() - span), to: new Date(at.getTime() + span) };
}

/**
 * The due-soon list: the open tasks due within 7 days of today in their own trip's zone,
 * overdue ones included, in due order; then the caller's own reminders in the window,
 * soonest first. `todayOf` is today in a trip's zone.
 */
export function dueSoon(
  open: readonly ItemRecord[],
  reminders: readonly ReminderRecord[],
  todayOf: (tripId: string) => string,
): DueSoonRecord[] {
  const due = open.filter((t) => isDueBy(t, addDays(todayOf(t.tripId), DUE_SOON_DAYS)));
  return [
    ...due.map((item): DueSoonRecord => ({ kind: 'task_due', item })),
    ...reminders.map(({ item, reminderAt }): DueSoonRecord => ({
      kind: 'reminder',
      item,
      reminderAt,
    })),
  ];
}
