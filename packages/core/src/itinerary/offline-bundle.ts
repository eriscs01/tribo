// trips.offlineBundle: everything the caller may read of one trip, for the SPA to keep in
// IndexedDB (Technical design, "Offline"). Served by the itinerary module, the read-only
// engine over the others, as the dashboard is (decision 0012): each part comes from its
// owner's own masked read (trips, items, expenses, documents, through trips the library),
// never from their tables, so the bundle masks and hides exactly as those reads do and holds
// no revealed value (decision 0027).
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { tripFiles, type FileRecord } from '../documents/service.js';
import { tripExpenses, type ExpenseRecord } from '../expenses/service.js';
import {
  itemBoards,
  ownOverlays,
  ownTickets,
  tripItems,
  type BoardRecord,
  type ItemRecord,
  type OverlayRecord,
  type TicketRecord,
  type UnitRecord,
} from '../items/service.js';
import { memberTrip, tripMembers, type MemberRecord, type TripRecord } from '../trips/service.js';
import { canReadOfflineBundle } from './policy.js';
import { isMine, laidOut, type DayRecord, type WarningRecord } from './timeline.js';

/** One view of the itinerary: its days and the rule checks over them; the items are the bundle's. */
interface OfflineItinerary {
  days: DayRecord[];
  warnings: WarningRecord[];
}

export interface OfflineBundleRecord {
  trip: TripRecord;
  /** The caller's own membership in the trip, one of `members`. */
  membershipId: string;
  members: MemberRecord[];
  items: ItemRecord[];
  units: UnitRecord[];
  boards: BoardRecord[];
  itinerary: { me: OfflineItinerary; group: OfflineItinerary };
  /** The caller's own tickets only. */
  tickets: TicketRecord[];
  /** The caller's own overlays only; none for a viewer. */
  overlays: OverlayRecord[];
  expenses: ExpenseRecord[];
  files: FileRecord[];
  /** True when some collection held more than the ceiling and was cut to it. */
  truncated: boolean;
}

export interface OfflineBundleService {
  /** trips.offlineBundle: any member of the trip; not_found to everyone else. */
  get(userId: string, tripId: string): Promise<OfflineBundleRecord>;
}

/** The most rows a bundle carries of any one collection (decision 0027). */
export const OFFLINE_BUNDLE_MAX_ROWS = 2000;

export interface OfflineBundleDeps {
  /** The ceiling per collection; tests lower it. */
  maxRows?: number;
}

export function createOfflineBundleService(
  db: Kysely<DB>,
  deps: OfflineBundleDeps = {},
): OfflineBundleService {
  const max = deps.maxRows ?? OFFLINE_BUNDLE_MAX_ROWS;
  return {
    async get(userId, tripId) {
      // Members only: anyone else, a removed member or a deleted trip is not_found.
      const { trip, viewer } = await memberTrip(db, userId, tripId, canReadOfflineBundle);
      // One row past the ceiling tells a full collection from a cut one.
      const over = max + 1;
      const [members, visible, tickets, overlays, expenses, files] = await Promise.all([
        tripMembers(db, viewer, tripId, over),
        tripItems(db, userId, viewer, tripId, {}, over),
        ownTickets(db, userId, viewer, tripId, over),
        ownOverlays(db, userId, viewer, tripId, over),
        tripExpenses(db, userId, viewer, trip, over),
        tripFiles(db, userId, viewer, tripId, over),
      ]);
      const items = visible.items.slice(0, max);
      // The children of an item left out stay out with it.
      const kept = new Set(items.map((i) => i.item.id));
      const onKept = <T extends { itemId: string }>(rows: readonly T[]) =>
        rows.filter((r) => kept.has(r.itemId)).slice(0, max);
      const warnings = onKept(visible.warnings);
      const view = (shown: typeof items): OfflineItinerary => {
        const { days, warnings: checks } = laidOut(shown, warnings, {});
        return { days, warnings: checks };
      };
      return {
        trip,
        membershipId: viewer.id,
        members: members.slice(0, max),
        items: items.map((i) => i.item),
        units: onKept(visible.units),
        boards: itemBoards({ items, warnings }),
        itinerary: { me: view(items.filter((i) => isMine(i, viewer))), group: view(items) },
        tickets: onKept(tickets),
        overlays: onKept(overlays),
        expenses: expenses.slice(0, max),
        files: files.slice(0, max),
        truncated: [members, visible.items, visible.units, tickets, overlays, expenses, files].some(
          (rows) => rows.length > max,
        ),
      };
    },
  };
}
