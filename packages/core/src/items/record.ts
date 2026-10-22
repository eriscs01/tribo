// The one serializer every item read goes through, and the time shapes it renders: what an
// item is to one reader. Private to the module; service.ts and timeline.ts build on it.
import { ItemMaskedField } from '@tribo/contract';
import type { ValueOf } from '@tribo/db';
import type { CallerMembership } from '../trips/service.js';
import { moneyView, restrictedHidden } from './acting.js';
import type { ItemRow } from './repo.js';

/** A stored time: wall-clock plus zone with its resolved instant, or an all-day date. */
export type ItemTimeRecord = { local: string; tz: string; at: Date } | { date: string };

export interface ItemRecord {
  id: string;
  tripId: string;
  type: ValueOf<'tribo.items.type'>;
  title: string;
  status: ValueOf<'tribo.items.status'>;
  start: ItemTimeRecord | null;
  end: ItemTimeRecord | null;
  visibility: ValueOf<'tribo.items.visibility'>;
  ownerMembershipId: string;
  tags: string[];
  /** The booked price, or 'masked' for a caller who may not read costs or it is restricted for. */
  cost: { amountMinor: number; currency: string } | 'masked' | null;
  /**
   * 'masked' when a booking ref or card last-4 is stored (their values are masked for every
   * reader), or when the field is restricted for this caller, stored or not.
   */
  bookingRef: 'masked' | null;
  cardLast4: 'masked' | null;
  /** Fields masked for every caller but the item's owner and the trip's owner and organizers. */
  restrictedFields: ItemMaskedField[];
  version: number;
  boardVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

function time(
  at: Date | null,
  tz: string | null,
  local: string | null,
  date: string | null,
): ItemTimeRecord | null {
  if (at !== null && tz !== null && local !== null) return { local, tz, at };
  return date === null ? null : { date };
}

export function startOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.start_at, row.start_tz, row.start_local, row.start_date);
}

export function endOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.end_at, row.end_tz, row.end_local, row.end_date);
}

/** A set of maskable fields in the closed set's own order, whatever order it came in. */
export function inFieldOrder(fields: readonly string[]): ItemMaskedField[] {
  return ItemMaskedField.options.filter((f) => fields.includes(f));
}

/**
 * The item as this caller reads it, the one serializer every item read goes through:
 * sensitive values masked for all, costs per canViewCosts, and restricted fields masked,
 * present or not, for every caller but the item's owner and the trip's owners and organizers.
 */
export function itemRecord(
  row: ItemRow,
  viewer: Pick<CallerMembership, 'id' | 'role' | 'canViewCosts'>,
): ItemRecord {
  const hidden = (field: ItemMaskedField) => restrictedHidden(row, viewer, field);
  const stored =
    row.cost_minor === null || row.cost_currency === null
      ? null
      : { amountMinor: Number(row.cost_minor), currency: row.cost_currency };
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type as ItemRecord['type'],
    title: row.title,
    status: row.status as ItemRecord['status'],
    start: startOf(row),
    end: endOf(row),
    visibility: row.visibility as ItemRecord['visibility'],
    ownerMembershipId: row.owner_membership_id,
    tags: row.tags,
    cost: moneyView(row, viewer, stored),
    bookingRef: hidden('bookingRef') || row.booking_ref_enc !== null ? 'masked' : null,
    cardLast4: hidden('cardLast4') || row.card_last4_enc !== null ? 'masked' : null,
    restrictedFields: inFieldOrder(row.restricted_fields),
    version: row.version,
    boardVersion: row.board_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
