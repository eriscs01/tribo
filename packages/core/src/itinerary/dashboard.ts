// trips.dashboard: one polled read that sums a trip up for the caller. Served by the itinerary
// module, the read-only engine over the others (decision 0012): the trip comes from the trips
// service, the items from the items service and my share from the expenses service.
import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { memberShare } from '../expenses/service.js';
import { ownReminders, tripItems, type ItemRecord, type TripItem } from '../items/service.js';
import { memberTrip } from '../trips/service.js';
import { canReadDashboard } from './policy.js';
import { localDate } from './repo.js';
import {
  byWhen,
  dueSoon,
  FINISHED,
  openTasks,
  reminderWindow,
  type DueSoonRecord,
} from './tasks.js';
import { laidOut, type WarningRecord } from './timeline.js';

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
  dueSoon: DueSoonRecord[];
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

/** Item types that are not somewhere to be, so never the next item. */
const NOT_EVENTS = new Set<ItemRecord['type']>(['task', 'note', 'document']);

export function createDashboardService(db: Kysely<DB>, deps: DashboardDeps = {}): DashboardService {
  const now = deps.now ?? (() => new Date());
  return {
    async get(userId, tripId) {
      // Members only: anyone else, a removed member or a deleted trip is not_found.
      const { trip, viewer } = await memberTrip(db, userId, tripId, canReadDashboard);
      const at = now();
      const [today, visible, share, reminders] = await Promise.all([
        localDate(forModule(db, 'itinerary'), at, trip.timezone),
        tripItems(db, userId, viewer, tripId, {}),
        viewer.canViewCosts ? memberShare(db, tripId, viewer.id) : null,
        ownReminders(db, userId, [{ tripId, viewer }], reminderWindow(at)),
      ]);
      const open = openTasks(visible.items, viewer.id);
      return {
        tripId: trip.id,
        name: trip.name,
        countdown: countdown(trip, today),
        nextItem: nextItem(visible.items, at, today),
        openTasks: open,
        dueSoon: dueSoon(open, reminders, () => today, at),
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
