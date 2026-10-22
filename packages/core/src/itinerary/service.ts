// The itinerary module: a read-only engine over the items service (Sprint 0 layout). It owns
// no table; it asks items for what the caller can see and lays it out by day.
import type { ItineraryQuery, ItineraryView } from '@tribo/contract';
import type { DB } from '@tribo/db';
import { ApiError } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { tripItems, type ItemRecord, type TripItem } from '../items/service.js';
import { callerMembership, type CallerMembership } from '../trips/service.js';
import { canGetItinerary } from './policy.js';
import { overlapWarnings, timelineDays, type DayRange, type DayRecord } from './timeline.js';

/** A rule check on the itinerary's items, naming the item (and unit, or other item) it is about. */
export interface WarningRecord {
  code: 'overlap' | 'no_licensed_driver';
  itemId: string;
  withItemId?: string;
  unitId?: string;
}

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
        ...itinerary(shown, visible.warnings, range),
      };
    },
  };
}

/** Whether a board row puts its member on the item: an attendee who said no is not. */
const onBoard = (r: TripItem['board'][number]) => !(r.role === 'attendee' && r.rsvp === 'no');

/**
 * view=me (Technical Design, "Itinerary"): the items the caller owns, attends, occupies,
 * drives, rides in or is assigned to, which is every row of theirs on the item's board but
 * an attendee's "no".
 */
function isMine({ item, board }: TripItem, viewer: CallerMembership): boolean {
  if (item.ownerMembershipId === viewer.id) return true;
  return board.some((r) => r.membershipId === viewer.id && onBoard(r));
}

/**
 * The timeline of these items within the range: its days, the items those days name, and
 * the rule checks on those items alone, so no check can reach past what the caller sees.
 */
function itinerary(
  shown: readonly TripItem[],
  vehicleWarnings: readonly WarningRecord[],
  range: DayRange,
): Pick<ItineraryRecord, 'days' | 'items' | 'warnings'> {
  const days = timelineDays(
    shown.map((i) => i.item),
    range,
  );
  const named = new Set(days.flatMap((d) => d.entries.map((e) => e.itemId)));
  const items = shown.filter((i) => named.has(i.item.id));
  const boards = new Map(
    items.map((i) => [i.item.id, i.board.filter(onBoard).map((r) => r.membershipId)]),
  );
  const warnings: WarningRecord[] = [
    ...overlapWarnings(
      items.map((i) => i.item),
      boards,
    ),
    ...vehicleWarnings.filter((w) => named.has(w.itemId)),
  ];
  return { days, items: items.map((i) => i.item), warnings: warnings.sort(byItem) };
}

/** Warnings in a stable order: by item, then code, then what else they name. */
function byItem(a: WarningRecord, b: WarningRecord): number {
  const key = (w: WarningRecord) => [w.itemId, w.code, w.withItemId ?? '', w.unitId ?? ''];
  const [x, y] = [key(a), key(b)];
  for (const [i, part] of x.entries()) {
    const other = y[i] ?? '';
    if (part !== other) return part < other ? -1 : 1;
  }
  return 0;
}
