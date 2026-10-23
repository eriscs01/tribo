// The per-passenger tickets of a transport item (Technical design, "tickets"): seat, a sealed
// ticket number and baggage, edited apart from the assignment board. A ticket follows its
// item's visibility (children follow their item); its number is masked on every read and
// leaves the database only through tickets.reveal.
import { decodeTypeId, ID_PREFIX, TicketInput, type PageQuery } from '@tribo/contract';
import { seal, type Keyring } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  onConstraint,
  page,
  uuidCursor,
  type RequestContext,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { activeMembershipSet } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { actingEditor, invalid, lockedItem, visibleItem } from './acting.js';
import { canListTicket, canManageTickets } from './policy.js';
import {
  findSealedTicket,
  insertTicket,
  listTickets,
  newTicketId,
  type SealedTicketRow,
  type StoredBaggage,
  type TicketRow,
} from './ticket-repo.js';

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
  /**
   * tickets.create: a passenger's ticket on a transport item, its number sealed. The item's
   * owner and the trip's owners and organizers add it (G4); an item the caller cannot see is
   * not_found before anything else is asked. The passenger is an active membership of the
   * trip holding no live ticket on the item, else validation_failed at /passenger.
   */
  create(ctx: RequestContext, itemId: string, body: unknown): Promise<TicketRecord>;
}

const ticketsCreate = writeOperation('tickets.create', TicketInput);

/** Where one ticket's sealed number lives: it opens only for that row and column (AAD). */
const sealedNumber = (ticketId: string) => ({
  table: 'tickets',
  column: 'ticket_no_enc',
  rowId: ticketId,
});

/** Baggage as stored: only what was given, in the column's own key style. */
function storedBaggage(input: NonNullable<TicketInput['baggage']>): StoredBaggage {
  return {
    ...(input.checkedKg == null ? {} : { checked_kg: input.checkedKg }),
    ...(input.cabinKg == null ? {} : { cabin_kg: input.cabinKg }),
    ...(input.addOns === undefined || input.addOns.length === 0 ? {} : { add_ons: input.addOns }),
  };
}

/** Every stored field of the ticket (Audit and versioning); the number only as the sealed bytes. */
function ticketSnapshot(row: SealedTicketRow) {
  return {
    itemId: row.item_id,
    membershipId: row.membership_id,
    seat: row.seat,
    baggage: { ...baggageRecord(row.baggage) },
    ticketNoEnc: row.ticket_no_enc?.toString('base64') ?? null,
  };
}

/** The passenger must be an active member of the item's trip; anyone else is one answer. */
async function checkedPassenger(tx: Kysely<DB>, tripId: string, passenger: string) {
  const membershipId = decodeTypeId(ID_PREFIX.membership, passenger);
  if (!(await activeMembershipSet(tx, tripId, [membershipId])).has(membershipId)) {
    throw invalid('/passenger', 'not a member of this trip');
  }
  return membershipId;
}

/** A second live ticket for the passenger on the item is the caller's to resolve. */
function onePerPassenger<T>(write: () => Promise<T>): Promise<T> {
  return write().catch((error: unknown) =>
    onConstraint(error, {
      tickets_item_member_key: () =>
        invalid('/passenger', 'this passenger already has a ticket on this item'),
    }),
  );
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
  write: WritePath,
  keys: Keyring,
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

    create(ctx, itemId, body) {
      return write(ctx, {
        operation: ticketsCreate,
        target: { itemId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canManageTickets(acting.editor)) throw new ApiError('forbidden');
          return acting;
        },
        // The item stays live, and its tickets stop changing under us, until the ticket is in.
        load: async (tx, target) => {
          const { tripId, row } = await lockedItem(tx, target);
          return { tripId, row };
        },
        mutate: async (tx, _c, { row: item }, input, { userId }) => {
          if (item.type !== 'transport') {
            throw invalid('/itemId', `a ${item.type} item has no tickets`);
          }
          const membershipId = await checkedPassenger(tx, item.trip_id, input.passenger);
          const items = forModule(tx, 'items');
          const id = await newTicketId(items);
          await onePerPassenger(() =>
            insertTicket(items, {
              id,
              tripId: item.trip_id,
              itemId: item.id,
              membershipId,
              seat: input.seat ?? null,
              ticketNoEnc:
                input.ticketNo == null ? null : seal(keys, sealedNumber(id), input.ticketNo),
              baggage: storedBaggage(input.baggage ?? {}),
              createdBy: userId,
            }),
          );
          const row = await findSealedTicket(items, id);
          if (!row) throw new Error(`ticket ${id} vanished inside its own write`);
          return {
            action: 'create',
            aggregate: 'ticket',
            entityId: id,
            tripId: item.trip_id,
            version: row.version,
            snapshot: ticketSnapshot(row),
            result: ticketRecord(row),
          };
        },
      });
    },
  };
}
