// The tickets table: one live row per passenger (membership) and item. A read never selects
// the sealed ticket number, only whether there is one; reveal alone reads it.
import { sql } from 'kysely';
import type { ItemsDb } from './repo.js';

/** Baggage as stored (snake_case keys, the column's own comment in 0001_init.sql). */
export interface StoredBaggage {
  checked_kg?: number;
  cabin_kg?: number;
  add_ons?: string[];
}

function selectTicket(db: ItemsDb) {
  return db
    .selectFrom('tribo.tickets as t')
    .select([
      't.id',
      't.trip_id',
      't.item_id',
      't.membership_id',
      't.seat',
      sql<boolean>`t.ticket_no_enc IS NOT NULL`.as('has_ticket_no'),
      't.baggage',
      't.version',
      't.created_at',
      't.updated_at',
    ])
    .where('t.deleted_at', 'is', null);
}

export type TicketRow = Awaited<ReturnType<typeof listTickets>>[number];

/** One page of the item's live tickets in the order they were added; `after` is the last id. */
export function listTickets(
  db: ItemsDb,
  itemId: string,
  page: { limit: number; after: string | null },
) {
  let query = selectTicket(db).where('t.item_id', '=', itemId);
  if (page.after !== null) query = query.where('t.id', '>', page.after);
  return query.orderBy('t.id').limit(page.limit).execute();
}
