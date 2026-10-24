// The itinerary engine as pure functions of the items a caller can see: their days on the
// timeline, each in the item's own zone, which of them are the caller's, and the rule checks
// between them. No database: whatever the items service hides never reaches here, which is
// what keeps every summary read (itinerary, dashboard) from speaking of a hidden item.
import type { ItineraryPart } from '@tribo/contract';
import type { ItemRecord, TripItem } from '../items/service.js';
import type { CallerMembership } from '../trips/service.js';

export type TimelineItem = Pick<ItemRecord, 'id' | 'type' | 'status' | 'start' | 'end'>;

interface EntryRecord {
  itemId: string;
  part: ItineraryPart;
  /** HH:mm in `tz`; null for all-day items and a stay's nights. */
  time: string | null;
  tz: string | null;
}

export interface DayRecord {
  date: string;
  entries: EntryRecord[];
}

/** An inclusive range of local days; either end may be open. */
export interface DayRange {
  from?: string;
  to?: string;
}

export interface OverlapWarning {
  code: 'overlap';
  itemId: string;
  withItemId: string;
}

type Time = NonNullable<TimelineItem['start']>;

const dayOf = (t: Time) => ('date' in t ? t.date : t.local.slice(0, 10));
const lineAt = (itemId: string, part: ItineraryPart, t: Time): EntryRecord =>
  'date' in t
    ? { itemId, part, time: null, tz: null }
    : { itemId, part, time: t.local.slice(11, 16), tz: t.tz };

/** The calendar day `days` after `date` (YYYY-MM-DD), in no zone: dates are already local. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One item's lines by local day: whole, or start and end; a stay as check-in, nights, check-out. */
function itemLines(item: TimelineItem): [string, EntryRecord][] {
  const { start, end } = item;
  if (start === null) return [];
  const first = dayOf(start);
  const last = end === null ? first : dayOf(end);
  if (item.type === 'lodging') {
    const lines: [string, EntryRecord][] = [[first, lineAt(item.id, 'check_in', start)]];
    for (let d = addDays(first, 1); d < last; d = addDays(d, 1)) {
      lines.push([d, { itemId: item.id, part: 'staying', time: null, tz: null }]);
    }
    if (end !== null) lines.push([last, lineAt(item.id, 'check_out', end)]);
    return lines;
  }
  if (end === null || last === first) return [[first, lineAt(item.id, 'whole', start)]];
  return [
    [first, lineAt(item.id, 'start', start)],
    [last, lineAt(item.id, 'end', end)],
  ];
}

/** All-day lines first, then by local time, then by item id: a stable order for the ETag. */
function byTime(a: EntryRecord, b: EntryRecord): number {
  if (a.time !== b.time) {
    if (a.time === null) return -1;
    if (b.time === null) return 1;
    return a.time < b.time ? -1 : 1;
  }
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  return a.part.localeCompare(b.part);
}

/**
 * The days of the range that have lines, in date order. Each item is bucketed by its own
 * local dates (Technical Design, "Itinerary"); undated items have no day.
 */
export function timelineDays(items: readonly TimelineItem[], range: DayRange): DayRecord[] {
  const days = new Map<string, EntryRecord[]>();
  const inRange = (date: string) =>
    (range.from === undefined || date >= range.from) &&
    (range.to === undefined || date <= range.to);
  for (const [date, line] of items.flatMap(itemLines).filter(([d]) => inRange(d))) {
    days.set(date, [...(days.get(date) ?? []), line]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, entries]) => ({ date, entries: entries.sort(byTime) }));
}

/**
 * Item types a person is at for the length of the item. A stay or a rental spans the
 * days other items happen in, so they never overlap them; tasks, notes and documents
 * are not somewhere to be.
 */
const ATTENDED = new Set<TimelineItem['type']>(['transport', 'activity', 'meal']);

/** The [start, end) instants of an item someone attends, or null when it is not one. */
function attendedSpan(item: TimelineItem): { from: number; to: number } | null {
  const { start, end } = item;
  if (!ATTENDED.has(item.type) || item.status === 'cancelled') return null;
  if (start === null || end === null || 'date' in start || 'date' in end) return null;
  const span = { from: start.at.getTime(), to: end.at.getTime() };
  return span.to > span.from ? span : null;
}

/**
 * `overlap` (Rule checks): two timed items someone attends whose times overlap, with at
 * least one membership on both boards (`boards`, by item id). One warning per pair, on the
 * pair's first item by id. Items that only touch (one ends as the next starts) don't overlap.
 */
export function overlapWarnings(
  items: readonly TimelineItem[],
  boards: ReadonlyMap<string, readonly string[]>,
): OverlapWarning[] {
  const spans = items
    .map((item) => ({ id: item.id, span: attendedSpan(item) }))
    .filter((s): s is { id: string; span: { from: number; to: number } } => s.span !== null)
    .sort((a, b) => a.span.from - b.span.from);
  const warnings: OverlapWarning[] = [];
  for (const [i, a] of spans.entries()) {
    const onA = new Set(boards.get(a.id) ?? []);
    // Sorted by start, so the items after a that start before it ends are all that overlap it.
    for (const b of spans.slice(i + 1)) {
      if (b.span.from >= a.span.to) break;
      if ((boards.get(b.id) ?? []).some((m) => onA.has(m))) {
        const [itemId, withItemId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        warnings.push({ code: 'overlap', itemId, withItemId });
      }
    }
  }
  return warnings.sort((x, y) =>
    x.itemId === y.itemId
      ? x.withItemId.localeCompare(y.withItemId)
      : x.itemId.localeCompare(y.itemId),
  );
}

/** A rule check on the itinerary's items, naming the item (and unit, or other item) it is about. */
export interface WarningRecord {
  code: 'overlap' | 'no_licensed_driver';
  itemId: string;
  withItemId?: string;
  unitId?: string;
}

/** Whether a board row puts its member on the item: an attendee who said no is not. */
const onBoard = (r: TripItem['board'][number]) => !(r.role === 'attendee' && r.rsvp === 'no');

/**
 * view=me (Technical Design, "Itinerary"): the items the caller owns, attends, occupies,
 * drives, rides in or is assigned to, which is every row of theirs on the item's board but
 * an attendee's "no".
 */
export function isMine({ item, board }: TripItem, viewer: CallerMembership): boolean {
  if (item.ownerMembershipId === viewer.id) return true;
  return board.some((r) => r.membershipId === viewer.id && onBoard(r));
}

/**
 * The timeline of these items within the range: its days, the items those days name, and
 * the rule checks on those items alone, so no check can reach past what the caller sees.
 */
export function laidOut(
  shown: readonly TripItem[],
  vehicleWarnings: readonly WarningRecord[],
  range: DayRange,
): { days: DayRecord[]; items: ItemRecord[]; warnings: WarningRecord[] } {
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
  const key = (w: WarningRecord) =>
    [w.itemId, w.code, w.withItemId ?? '', w.unitId ?? ''].join('\u0000');
  return key(a).localeCompare(key(b));
}
