// me.tasks: the caller's open tasks across the trips they are in, and their due-soon list.
// Served by the itinerary module, the read-only engine over the others (decision 0012): the
// trips come from the trips service and the tasks and reminders from the items service.
import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { ownReminders, visibleTasks, type ItemRecord } from '../items/service.js';
import { callerTrips } from '../trips/service.js';
import { canListMyTasks } from './policy.js';
import { localDate } from './repo.js';
import { byWhen, dueSoon, openTasks, reminderWindow, type DueSoonRecord } from './tasks.js';

export interface MyTasksRecord {
  /** The caller's open tasks across their trips, by due date. */
  tasks: { tripName: string; item: ItemRecord }[];
  dueSoon: DueSoonRecord[];
}

export interface MyTasksService {
  /** me.tasks: the signed-in caller's own tasks and reminders; nothing of anyone else's. */
  get(userId: string): Promise<MyTasksRecord>;
}

export interface MyTasksDeps {
  /** The clock due soon reads; tests pin it. */
  now?: () => Date;
}

export function createMyTasksService(db: Kysely<DB>, deps: MyTasksDeps = {}): MyTasksService {
  const now = deps.now ?? (() => new Date());
  return {
    async get(userId) {
      // Trips deleted or left drop out here; archived ones are over, so they hold nothing to do.
      const trips = (await callerTrips(db, userId)).filter(
        (t) => !t.archived && canListMyTasks(t.viewer.role),
      );
      if (trips.length === 0) return { tasks: [], dueSoon: [] };
      const at = now();
      const seats = trips.map((t) => ({ tripId: t.tripId, viewer: t.viewer }));
      const zones = [...new Set(trips.map((t) => t.timezone))];
      const [visible, reminders, todays] = await Promise.all([
        visibleTasks(db, userId, seats),
        ownReminders(db, userId, seats, reminderWindow(at)),
        Promise.all(
          zones.map(
            async (tz) => [tz, await localDate(forModule(db, 'itinerary'), at, tz)] as const,
          ),
        ),
      ]);
      const today = new Map(todays);
      const byTrip = Map.groupBy(visible, ({ item }) => item.tripId);
      const open = trips.flatMap((t) => openTasks(byTrip.get(t.tripId) ?? [], t.viewer.id));
      const trip = new Map(trips.map((t) => [t.tripId, t]));
      const todayOf = (tripId: string) => today.get(trip.get(tripId)?.timezone ?? '') ?? '';
      return {
        tasks: open
          .sort(byWhen)
          .map((item) => ({ tripName: trip.get(item.tripId)?.name ?? '', item })),
        dueSoon: dueSoon(open, reminders, todayOf),
      };
    },
  };
}
