// The itinerary module: a read-only engine over the items service (Sprint 0 layout). It owns
// no table; it asks items for what the caller can see and lays it out by day.
import type { ItineraryQuery, ItineraryView } from '@tribo/contract';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { tripItems, type ItemRecord } from '../items/service.js';
import { callerMembership } from '../trips/service.js';
import { canGetItinerary } from './policy.js';
import { isMine, laidOut, type DayRange, type DayRecord, type WarningRecord } from './timeline.js';

export {
  createDashboardService,
  type DashboardDeps,
  type DashboardRecord,
  type DashboardService,
} from './dashboard.js';
export {
  createMyTasksService,
  type MyTasksDeps,
  type MyTasksRecord,
  type MyTasksService,
} from './my-tasks.js';
export type { DueSoonRecord } from './tasks.js';
export type { WarningRecord } from './timeline.js';

export interface ItineraryRecord {
  view: ItineraryView;
  from: string | null;
  to: string | null;
  days: DayRecord[];
  items: ItemRecord[];
  warnings: WarningRecord[];
}

export interface ItineraryService {
  /** itinerary.get: the caller's day timeline of the trip; not_found outside it. */
  get(userId: string, tripId: string, query: ItineraryQuery): Promise<ItineraryRecord>;
}

export function createItineraryService(db: Kysely<DB>): ItineraryService {
  return {
    async get(userId, tripId, query) {
      const viewer = await callerMembership(db, userId, tripId);
      // A trip the caller is not in does not exist for them.
      if (viewer === null) throw new ApiError('not_found');
      if (!canGetItinerary(viewer.role)) throw new ApiError('forbidden');
      const range: DayRange = {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
      };
      const visible = await tripItems(db, userId, viewer, tripId, range);
      const shown =
        query.view === 'me' ? visible.items.filter((i) => isMine(i, viewer)) : visible.items;
      return {
        view: query.view,
        from: query.from ?? null,
        to: query.to ?? null,
        ...laidOut(shown, visible.warnings, range),
      };
    },
  };
}
