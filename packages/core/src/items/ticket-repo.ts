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

const TICKET_COLUMNS = [
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
] as const;

function selectTicket(db: ItemsDb) {
  return db
    .selectFrom('tribo.tickets as t')
    .select(TICKET_COLUMNS)
    .where('t.deleted_at', 'is', null);
}

/** As selectTicket, with the sealed number, for the writes that keep it in the ticket's snapshot. */
function selectSealedTicket(db: ItemsDb) {
  return selectTicket(db).select('t.ticket_no_enc');
}

export type TicketRow = Awaited<ReturnType<typeof listTickets>>[number];

/** A ticket with its sealed number, as the writes load and re-read it. */
export type SealedTicketRow = NonNullable<Awaited<ReturnType<typeof findSealedTicket>>>;

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

/** The live ticket, whether or not the caller sees its item: that is not asked here. */
export function findTicket(db: ItemsDb, ticketId: string) {
  return selectTicket(db).where('t.id', '=', ticketId).executeTakeFirst();
}

/** The live ticket with its sealed number, locked FOR UPDATE until the write commits. */
export function lockSealedTicket(db: ItemsDb, ticketId: string) {
  return selectSealedTicket(db).where('t.id', '=', ticketId).forUpdate().executeTakeFirst();
}

/** The live ticket with its sealed number, for the writer that just changed it, inside its transaction. */
export function findSealedTicket(db: ItemsDb, ticketId: string) {
  return selectSealedTicket(db).where('t.id', '=', ticketId).executeTakeFirst();
}

/** An id for a ticket that does not exist yet: its sealed number binds to it (AAD). */
export async function newTicketId(db: ItemsDb): Promise<string> {
  const { rows } = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(db);
  return rows[0]?.id ?? '';
}

export interface NewTicket {
  id: string;
  tripId: string;
  itemId: string;
  membershipId: string;
  seat: string | null;
  ticketNoEnc: Buffer | null;
  baggage: StoredBaggage;
  createdBy: string;
}

/** Writes the passenger's first live ticket on the item; the unique index refuses a second. */
export async function insertTicket(db: ItemsDb, ticket: NewTicket): Promise<void> {
  await db
    .insertInto('tribo.tickets')
    .values({
      id: ticket.id,
      trip_id: ticket.tripId,
      item_id: ticket.itemId,
      membership_id: ticket.membershipId,
      seat: ticket.seat,
      ticket_no_enc: ticket.ticketNoEnc,
      baggage: JSON.stringify(ticket.baggage),
      created_by: ticket.createdBy,
      updated_by: ticket.createdBy,
    })
    .execute();
}

/** What a tickets.update changes; an absent key keeps its column. */
export interface TicketChanges {
  membershipId?: string;
  seat?: string | null;
  ticketNoEnc?: Buffer | null;
  baggage?: StoredBaggage;
}

/** Applies the changes and bumps the ticket's version. */
export async function updateTicket(
  db: ItemsDb,
  ticketId: string,
  changes: TicketChanges,
  updatedBy: string,
): Promise<void> {
  await db
    .updateTable('tribo.tickets')
    .set((eb) => ({
      ...(changes.membershipId === undefined ? {} : { membership_id: changes.membershipId }),
      ...(changes.seat === undefined ? {} : { seat: changes.seat }),
      ...(changes.ticketNoEnc === undefined ? {} : { ticket_no_enc: changes.ticketNoEnc }),
      ...(changes.baggage === undefined ? {} : { baggage: JSON.stringify(changes.baggage) }),
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
      updated_by: updatedBy,
    }))
    .where('id', '=', ticketId)
    .execute();
}

/** Stamps deleted_at and bumps the version; a new ticket for the passenger may follow. */
export async function softDeleteTicket(
  db: ItemsDb,
  ticketId: string,
  deletedBy: string,
): Promise<number> {
  const row = await db
    .updateTable('tribo.tickets')
    .set((eb) => ({
      deleted_at: sql<Date>`now()`,
      deleted_by: deletedBy,
      updated_at: sql<Date>`now()`,
      updated_by: deletedBy,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', ticketId)
    .returning('version')
    .executeTakeFirstOrThrow();
  return row.version;
}
