// The per-passenger tickets of a transport item (Technical design, "tickets"): seat, a sealed
// ticket number and baggage, edited apart from the assignment board. A ticket follows its
// item's visibility (children follow their item); its number is masked on every read and
// leaves the database only through tickets.reveal.
import { decodeTypeId, ID_PREFIX, TicketInput, TicketPatch, type PageQuery } from '@tribo/contract';
import { seal, type Keyring } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  actingUser,
  ApiError,
  onConstraint,
  page,
  uuidCursor,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { activeMembershipSet, callerMembership } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { actingEditor, invalid, lockedItem, visibleItem } from './acting.js';
import { canListTicket, canManageTickets, ticketEdit } from './policy.js';
import { findVisibleItem, lockItem } from './repo.js';
import {
  findSealedTicket,
  findTicket,
  insertTicket,
  listTickets,
  lockSealedTicket,
  newTicketId,
  updateTicket,
  type TicketChanges,
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
  /**
   * tickets.update: merge-patches the ticket under If-Match = its version. Whoever manages
   * the item's tickets changes everything; a member changes only the seat and baggage of
   * their own ticket (masked_field_write for a passenger or number). A ticket the caller
   * cannot see (its item hidden, deleted, its passenger gone, or unknown) is not_found.
   */
  update(
    ctx: RequestContext,
    ticketId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<TicketRecord>;
}

const ticketsCreate = writeOperation('tickets.create', TicketInput);
const ticketsUpdate = writeOperation('tickets.update', TicketPatch);

/** Stands in for the item or trip of a ticket that does not exist, so its lookups still run. */
const NO_ROW = '00000000-0000-0000-0000-000000000000';

/** Where one ticket's sealed number lives: it opens only for that row and column (AAD). */
const sealedNumber = (ticketId: string) => ({
  table: 'tickets',
  column: 'ticket_no_enc',
  rowId: ticketId,
});

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

/**
 * A ticket the caller may know exists, with its item and their membership, or not_found.
 * The item comes first (children follow their item): a ticket of an item the caller cannot
 * see, of a deleted one, of a passenger who has left, deleted or unknown is one answer, and
 * the same queries run for each, so neither the answer nor its cost tells them apart.
 */
async function readableTicket(db: Kysely<DB>, userId: string, ticketId: string) {
  const items = forModule(db, 'items');
  const ticket = await findTicket(items, ticketId);
  const item = await findVisibleItem(items, userId, ticket?.item_id ?? NO_ROW);
  const tripId = item?.trip_id ?? NO_ROW;
  const membership = await callerMembership(db, userId, tripId);
  const present = await activeMembershipSet(db, tripId, [ticket?.membership_id ?? NO_ROW]);
  if (!ticket || !item || !membership || !present.has(ticket.membership_id)) {
    throw new ApiError('not_found');
  }
  return { ticket, item, membership };
}

/** The caller's ticket changes, as ticketEdit decides: what they may change, or forbidden. */
async function actingOnTicket(tx: Tx, ctx: RequestContext, ticketId: string) {
  const userId = actingUser(ctx);
  const { ticket, item, membership } = await readableTicket(tx, userId, ticketId);
  const edit = ticketEdit(
    { role: membership.role, owns: item.owner_membership_id === membership.id },
    ticket.membership_id === membership.id,
  );
  if (edit === null) throw new ApiError('forbidden');
  return { userId, edit, itemId: item.id };
}

type ActingTicket = Awaited<ReturnType<typeof actingOnTicket>>;

/** The write path's load for one ticket: its item, then the ticket, both locked until commit. */
async function lockedTicket(tx: Tx, target: { ticketId: string }, auth: ActingTicket) {
  const items = forModule(tx, 'items');
  const item = await lockItem(items, auth.itemId);
  const ticket = item ? await lockSealedTicket(items, target.ticketId) : undefined;
  if (!item || !ticket) throw new ApiError('not_found');
  return { tripId: item.trip_id, counter: ticket.version, item, ticket };
}

/** A merge patch's value for one key: absent keeps what is stored, null clears it. */
function patched<T>(given: T | null | undefined, stored: T | undefined): T | undefined {
  if (given === undefined) return stored;
  return given ?? undefined;
}

/**
 * The baggage after a merge patch: what was given replaces it key by key, null or an empty
 * list clears one, and only what is set is stored (in the column's own key style).
 */
function mergedBaggage(
  stored: StoredBaggage,
  patch: NonNullable<TicketPatch['baggage']>,
): StoredBaggage {
  const checked = patched(patch.checkedKg, stored.checked_kg);
  const cabin = patched(patch.cabinKg, stored.cabin_kg);
  const addOns = patched(patch.addOns, stored.add_ons);
  return {
    ...(checked === undefined ? {} : { checked_kg: checked }),
    ...(cabin === undefined ? {} : { cabin_kg: cabin }),
    ...(addOns === undefined || addOns.length === 0 ? {} : { add_ons: addOns }),
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
              baggage: mergedBaggage({}, input.baggage ?? {}),
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

    update(ctx, ticketId, body, ifMatch) {
      return write(ctx, {
        operation: ticketsUpdate,
        target: { ticketId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnTicket(tx, c, target.ticketId),
        load: (tx, target, _input, auth) => lockedTicket(tx, target, auth),
        mutate: async (tx, _c, { item, ticket }, patch, { userId, edit }) => {
          // Who a ticket is for and its number are not a passenger's to change, and a masked
          // number sent back would overwrite the real one.
          const touchesRestricted = patch.passenger !== undefined || patch.ticketNo !== undefined;
          if (edit === 'seat_and_baggage' && touchesRestricted) {
            throw new ApiError('masked_field_write');
          }
          const { ticketNo } = patch;
          if (typeof ticketNo === 'object' && ticketNo !== null) {
            throw new ApiError('masked_field_write');
          }
          const membershipId =
            patch.passenger === undefined
              ? undefined
              : await checkedPassenger(tx, item.trip_id, patch.passenger);
          const changes: TicketChanges = {
            ...(membershipId === undefined || membershipId === ticket.membership_id
              ? {}
              : { membershipId }),
            ...(patch.seat === undefined ? {} : { seat: patch.seat }),
            ...(ticketNo === undefined
              ? {}
              : {
                  ticketNoEnc:
                    ticketNo === null ? null : seal(keys, sealedNumber(ticket.id), ticketNo),
                }),
            ...(patch.baggage === undefined
              ? {}
              : { baggage: mergedBaggage(ticket.baggage as StoredBaggage, patch.baggage) }),
          };
          const items = forModule(tx, 'items');
          await onePerPassenger(() => updateTicket(items, ticket.id, changes, userId));
          const row = await findSealedTicket(items, ticket.id);
          if (!row) throw new Error(`ticket ${ticket.id} vanished inside its own write`);
          return {
            action: 'update',
            aggregate: 'ticket',
            entityId: ticket.id,
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
