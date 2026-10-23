// trips.dashboard: one polled read that sums a trip up for the caller. Served by the itinerary
// module, the read-only engine over the others (decision 0012): the trip comes from the trips
// service, the items from the items service and my share from the expenses service.
import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { memberShare } from '../expenses/service.js';
import { tripItems, type ItemRecord, type TripItem } from '../items/service.js';
import { memberTrip, type CallerMembership } from '../trips/service.js';
import { canReadDashboard } from './policy.js';
import { localDate } from './repo.js';
import { addDays, laidOut, type WarningRecord } from './timeline.js';

export interface DashboardRecord {
  tripId: string;
  name: string;
  countdown: {
    startDate: string;
    endDate: string;
    timezone: string;
    daysToStart: number;
    phase: 'upcoming' | 'underway' | 'over';
  };
  nextItem: ItemRecord | null;
  openTasks: ItemRecord[];
  dueSoon: { kind: 'task_due'; item: ItemRecord }[];
  /** The caller's share of the trip's expenses (R36), or 'masked' when costs are not theirs to read. */
  myShare: { amountMinor: number; currency: string } | 'masked';
  warnings: WarningRecord[];
}

export interface DashboardService {
  /** trips.dashboard: any member of the trip; not_found to everyone else. */
  get(userId: string, tripId: string): Promise<DashboardRecord>;
}

export interface DashboardDeps {
  /** The clock the countdown, the next item and due soon read; tests pin it. */
  now?: () => Date;
}

/** How far ahead a task counts as due soon (Technical Design, "Reminders in 1a"). */
const DUE_SOON_DAYS = 7;

/** Item types that are not somewhere to be, so never the next item. */
const NOT_EVENTS = new Set<ItemRecord['type']>(['task', 'note', 'document']);

/** Statuses after which an item is nothing to look forward to or to do. */
const FINISHED = new Set<ItemRecord['status']>(['done', 'cancelled']);

export function createDashboardService(db: Kysely<DB>, deps: DashboardDeps = {}): DashboardService {
  const now = deps.now ?? (() => new Date());
  return {
    async get(userId, tripId) {
      // Members only: anyone else, a removed member or a deleted trip is not_found.
      const { trip, viewer } = await memberTrip(db, userId, tripId, canReadDashboard);
      const at = now();
      const [today, visible, share] = await Promise.all([
        localDate(forModule(db, 'itinerary'), at, trip.timezone),
        tripItems(db, userId, viewer, tripId, {}),
        viewer.canViewCosts ? memberShare(db, tripId, viewer.id) : null,
      ]);
      const open = openTasks(visible.items, viewer);
      return {
        tripId: trip.id,
        name: trip.name,
        countdown: countdown(trip, today),
        nextItem: nextItem(visible.items, at, today),
        openTasks: open,
        dueSoon: open
          .filter((t) => isDueBy(t, addDays(today, DUE_SOON_DAYS), at))
          .map((item) => ({ kind: 'task_due', item })),
        myShare: share === null ? 'masked' : { amountMinor: share, currency: trip.currency },
        warnings: laidOut(visible.items, visible.warnings, {}).warnings,
      };
    },
  };
}

/** Where today falls against the trip's dates, all in the trip's own zone. */
function countdown(
  trip: { startDate: string; endDate: string; timezone: string },
  today: string,
): DashboardRecord['countdown'] {
  const days = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  let phase: DashboardRecord['countdown']['phase'] = 'underway';
  if (today < trip.startDate) phase = 'upcoming';
  else if (today > trip.endDate) phase = 'over';
  return {
    startDate: trip.startDate,
    endDate: trip.endDate,
    timezone: trip.timezone,
    daysToStart: Math.max(0, days(today, trip.startDate)),
    phase,
  };
}

/**
 * An item's place in time for ordering: its local day, then all-day before timed, then the
 * instant. Undated items sort last.
 */
function when(item: ItemRecord): [string, number] {
  const { start } = item;
  if (start === null) return ['9999-12-31', Infinity];
  return 'date' in start ? [start.date, -Infinity] : [start.local.slice(0, 10), start.at.getTime()];
}

function byWhen(a: ItemRecord, b: ItemRecord): number {
  const [[dayA, atA], [dayB, atB]] = [when(a), when(b)];
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  if (atA !== atB) return atA < atB ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Whether the item starts later than now: a timed one after this instant, an all-day one today or later. */
function isAhead(item: ItemRecord, at: Date, today: string): boolean {
  const { start } = item;
  if (start === null) return false;
  return 'date' in start ? start.date >= today : start.at.getTime() > at.getTime();
}

/** The first item to start from now on, tasks, notes, documents and finished items aside. */
function nextItem(items: readonly TripItem[], at: Date, today: string): ItemRecord | null {
  return (
    items
      .map((i) => i.item)
      .filter((i) => !NOT_EVENTS.has(i.type) && !FINISHED.has(i.status) && isAhead(i, at, today))
      .sort(byWhen)[0] ?? null
  );
}

/**
 * The caller's open tasks, by due date: tasks not done or cancelled that they are assigned
 * to, or that they own with nobody assigned. A task's due is its start until typed details
 * give it its own (decision 0012).
 */
function openTasks(items: readonly TripItem[], viewer: CallerMembership): ItemRecord[] {
  return items
    .filter(({ item, board }) => {
      if (item.type !== 'task' || FINISHED.has(item.status)) return false;
      const assignees = board.filter((r) => r.role === 'assignee');
      if (assignees.some((r) => r.membershipId === viewer.id)) return true;
      return item.ownerMembershipId === viewer.id && assignees.length === 0;
    })
    .map((i) => i.item)
    .sort(byWhen);
}

/** Whether a task is due on or before `lastDay` (overdue included). */
function isDueBy(task: ItemRecord, lastDay: string, at: Date): boolean {
  const { start } = task;
  if (start === null) return false;
  if ('date' in start) return start.date <= lastDay;
  return start.at.getTime() <= at.getTime() + DUE_SOON_DAYS * 86_400_000;
}
