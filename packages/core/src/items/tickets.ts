// The per-passenger tickets of a transport item (Technical design, "tickets"): seat, a sealed
// ticket number and baggage, edited apart from the assignment board. A ticket follows its
// item's visibility (children follow their item); its number is masked on every read and
// leaves the database only through tickets.reveal.
import type { PageQuery } from '@tribo/contract';
import { forModule, type DB } from '@tribo/db';
import { ApiError, page, uuidCursor, type WritePath } from '@tribo/platform';
import type { Keyring } from '@tribo/crypto';
import type { Kysely } from 'kysely';
import { activeMembershipSet } from '../trips/service.js';
import { visibleItem } from './acting.js';
import { canListTicket } from './policy.js';
import { listTickets, type StoredBaggage, type TicketRow } from './ticket-repo.js';

/** Baggage as the API shows it. */
export interface BaggageRecord {
  checkedKg: number | null;
  cabinKg: number | null;
  addOns: string[];
}

/** One passenger's ticket; the number is 'masked' when one is stored, whoever reads. */
export interface TicketRecord {
  id: string;
  itemId: string;
  passenger: string;
  seat: string | null;
  ticketNo: 'masked' | null;
  baggage: BaggageRecord;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketsService {
  /**
   * tickets.list: the item's live tickets, ticket numbers masked; not_found unless
   * tribo.item_visible lets the caller see the item. Tickets of passengers who have left
   * the trip are left out.
   */
  list(
    userId: string,
    itemId: string,
    query: PageQuery,
  ): Promise<{ items: TicketRecord[]; nextCursor: string | null }>;
}

function baggageRecord(stored: unknown): BaggageRecord {
  const b = (stored ?? {}) as StoredBaggage;
  return { checkedKg: b.checked_kg ?? null, cabinKg: b.cabin_kg ?? null, addOns: b.add_ons ?? [] };
}

/** The one serializer every ticket read goes through: the number shows only that it exists. */
function ticketRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    passenger: row.membership_id,
    seat: row.seat,
    ticketNo: row.has_ticket_no ? 'masked' : null,
    baggage: baggageRecord(row.baggage),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `write` is core's write path (writePath in write-path.ts), passed in to keep imports
 * acyclic; `keys` seal and open the ticket number.
 */
export function createTicketsService(
  db: Kysely<DB>,
  _write: WritePath,
  _keys: Keyring,
): TicketsService {
  return {
    async list(userId, itemId, query) {
      const { row: item, viewer } = await visibleItem(db, userId, itemId);
      if (!canListTicket(viewer.role)) throw new ApiError('forbidden');
      const rows = await listTickets(forModule(db, 'items'), itemId, {
        limit: query.limit + 1,
        after: query.cursor === undefined ? null : uuidCursor(query.cursor),
      });
      const shown = page(rows, query.limit, (row) => [row.id]);
      const present = await activeMembershipSet(
        db,
        item.trip_id,
        shown.rows.map((row) => row.membership_id),
      );
      return {
        items: shown.rows.filter((row) => present.has(row.membership_id)).map(ticketRecord),
        nextCursor: shown.nextCursor,
      };
    },
  };
}
