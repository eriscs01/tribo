// The items side of the reads that sum up what is the caller's own across their trips (me.tasks,
// the trip dashboard's due soon): the tasks they can see, and the reminders they set on their
// own overlays. A fixed number of queries whatever the number of trips.
import type { DB } from '@tribo/db';
import { forModule } from '@tribo/db';
import type { Kysely } from 'kysely';
import type { CallerMembership } from '../trips/service.js';
import { itemRecord, type ItemRecord } from './record.js';
import { listItemsByIds, listBoards, listVisibleTasks } from './repo.js';
import { listReminders } from './overlay-repo.js';
import { canGetOverlay } from './policy.js';
import type { TripItem } from './trip-items.js';

/** The caller's seat in one trip: which trip, and their membership there. */
export interface TripSeat {
  tripId: string;
  viewer: CallerMembership;
}

/** One of the caller's own reminders, on an item they see. */
export interface ReminderRecord {
  item: ItemRecord;
  reminderAt: Date;
}

const seatsByTrip = (seats: readonly TripSeat[]) =>
  new Map(seats.map((seat) => [seat.tripId, seat.viewer]));

/**
 * The tasks of these trips that tribo.item_visible lets this account see, masked as the
 * caller's seat in each trip reads them, each with its board. Which of them are theirs to do
 * is the caller's rule to apply.
 */
export async function visibleTasks(
  db: Kysely<DB>,
  userId: string,
  seats: readonly TripSeat[],
): Promise<TripItem[]> {
  const items = forModule(db, 'items');
  const viewers = seatsByTrip(seats);
  const rows = await listVisibleTasks(
    items,
    userId,
    seats.map((s) => s.tripId),
  );
  const boards = Map.groupBy(
    await listBoards(
      items,
      rows.map((r) => r.id),
    ),
    (r) => r.item_id,
  );
  return rows.flatMap((row) => {
    const viewer = viewers.get(row.trip_id);
    if (!viewer) return [];
    return [
      {
        item: itemRecord(row, viewer),
        board: (boards.get(row.id) ?? []).map((r) => ({
          membershipId: r.membership_id,
          role: r.role as TripItem['board'][number]['role'],
          rsvp: r.rsvp as TripItem['board'][number]['rsvp'],
        })),
      },
    ];
  });
}

/**
 * The reminders the caller set on their own overlays in the window, on items they see,
 * soonest first. A viewer keeps no overlay, so a reminder left from before a demotion does
 * not show; nobody else's reminder is ever read.
 */
export async function ownReminders(
  db: Kysely<DB>,
  userId: string,
  seats: readonly TripSeat[],
  window: { from: Date; to: Date },
): Promise<ReminderRecord[]> {
  const items = forModule(db, 'items');
  const mine = seats.filter((s) => canGetOverlay(s.viewer.role));
  const rows = await listReminders(
    items,
    userId,
    mine.map((s) => s.viewer.id),
    window,
  );
  const viewers = seatsByTrip(mine);
  const itemRows = new Map(
    (
      await listItemsByIds(
        items,
        rows.map((r) => r.item_id),
      )
    ).map((r) => [r.id, r]),
  );
  return rows.flatMap((row) => {
    const itemRow = itemRows.get(row.item_id);
    const viewer = itemRow && viewers.get(itemRow.trip_id);
    // The overlay must be the caller's seat in that item's own trip.
    if (!itemRow || viewer?.id !== row.membership_id || row.reminder_at === null) return [];
    return [{ item: itemRecord(itemRow, viewer), reminderAt: row.reminder_at }];
  });
}
