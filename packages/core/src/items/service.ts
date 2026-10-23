import {
  decodeTypeId,
  ID_PREFIX,
  ItemInput,
  ItemMaskedField,
  itemTimeProblem,
  ItemPatch,
  ItemRevealInput,
  ItemRsvpInput,
  NoBody,
  type ItemListQuery,
  type ItemReveal,
  type ItemRevealField,
  type MaskedValue,
} from '@tribo/contract';
import { open, seal, type Keyring } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  actingUser,
  ApiError,
  onConstraint,
  page,
  uuidCursor,
  validate,
  type RequestContext,
  type Tx,
  type WritePath,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { deletedWithEntity, recordEvent } from '../audit/service.js';
import { allActiveMemberships, callerMembership, type MemberMove } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { actingEditor, boardSnapshot, invalid, lockedItem, visibleItem } from './acting.js';
import { endOf, inFieldOrder, itemRecord, startOf, type ItemRecord } from './record.js';
import {
  canCreateItem,
  canDeleteItem,
  canListItems,
  canNarrowVisibility,
  canRevealItem,
  canRsvpItem,
  canUpdateItem,
  seesRestrictedFields,
} from './policy.js';
import {
  bumpBoardVersion,
  deleteMemberAllocations,
  findItem,
  findVisibleItem,
  insertItem,
  insertShares,
  listBoard,
  listShares,
  listVisibleItems,
  lockBoardsWith,
  lockPrivateItemsOf,
  replaceShares,
  softDeleteItem,
  undeletePrivateItems,
  updateItem,
  upsertRsvp,
  type ItemRow,
} from './repo.js';

export type { ItemRecord, ItemTimeRecord } from './record.js';
export { ownReminders, visibleTasks, type ReminderRecord } from './my-items.js';
export { createOverlaysService, type OverlayRecord, type OverlaysService } from './overlays.js';
export {
  createTicketsService,
  type BaggageRecord,
  type TicketRecord,
  type TicketsService,
} from './tickets.js';
export { tripItems, type TripItem } from './trip-items.js';
export {
  createUnitsService,
  type AllocationRecord,
  type BoardRecord,
  type UnitRecord,
  type UnitsService,
} from './units.js';

export interface ItemsService {
  /** items.create: the caller's membership owns the new item. */
  create(ctx: RequestContext, tripId: string, body: unknown): Promise<ItemRecord>;
  /** items.get: not_found unless tribo.item_visible lets the caller see it. */
  get(userId: string, itemId: string): Promise<ItemRecord>;
  /** items.list: the trip's items the caller may see; not_found outside the trip. */
  list(
    userId: string,
    tripId: string,
    query: ItemListQuery,
  ): Promise<{ items: ItemRecord[]; nextCursor: string | null }>;
  /** items.update: merge-patches the item under If-Match = its version. */
  update(
    ctx: RequestContext,
    itemId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<ItemRecord>;
  /**
   * items.delete: soft-deletes the item under If-Match; its children drop out with it, and
   * items.restore (1b) brings both back.
   */
  delete(
    ctx: RequestContext,
    itemId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<void>;
  /**
   * items.rsvp: replaces the caller's own answer on the item's board under the item lock,
   * bumping board_version, never the item version. Takes no If-Match: the answer is theirs.
   */
  rsvp(ctx: RequestContext, itemId: string, body: unknown): Promise<RsvpRecord>;
  /**
   * items.reveal: the plaintext of the masked fields asked for, with a reveal audit event
   * naming the field paths, never the values. A read, so it works on archived trips; a
   * retired trip refuses the event, and with it the reveal (trip_retired).
   */
  reveal(ctx: RequestContext, itemId: string, body: unknown): Promise<ItemReveal>;
}

/** The caller's attendee row after items.rsvp. */
interface RsvpRecord {
  itemId: string;
  membershipId: string;
  rsvp: 'yes' | 'no' | 'maybe';
  boardVersion: number;
}

/** The sealed column behind each field a reveal can show. */
const SEALED_COLUMN = {
  bookingRef: 'booking_ref_enc',
  cardLast4: 'card_last4_enc',
} as const satisfies Record<ItemRevealField, string>;

/** Where one item's sealed value lives: it opens only for that row and column (AAD). */
const sealedField = (rowId: string, column: string) => ({ table: 'items', column, rowId });

const itemsCreate = writeOperation('items.create', ItemInput);
const itemsUpdate = writeOperation('items.update', ItemPatch);
const itemsDelete = writeOperation('items.delete', NoBody);
const itemsRsvp = writeOperation('items.rsvp', ItemRsvpInput);

/**
 * `write` is core's write path (writePath in write-path.ts), passed in to keep imports
 * acyclic; `keys` seal and open the booking ref and card last-4.
 */
export function createItemsService(db: Kysely<DB>, write: WritePath, keys: Keyring): ItemsService {
  return {
    create(ctx, tripId, body) {
      return write(ctx, {
        operation: itemsCreate,
        target: { tripId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          const userId = actingUser(c);
          const membership = await callerMembership(tx, userId, target.tripId);
          // A trip the caller is not in does not exist for them.
          if (membership === null) throw new ApiError('not_found');
          if (!canCreateItem(membership.role)) throw new ApiError('forbidden');
          // The acting account and its membership, which owns the item.
          return { userId, membership };
        },
        load: (_tx, target) => Promise.resolve({ tripId: target.tripId }),
        mutate: async (tx, _c, loaded, input, { userId: createdBy, membership }) => {
          const ownerMembershipId = membership.id;
          const sharedWith = await tripMemberships(tx, tripId, input.sharedWith ?? []);
          const items = forModule(tx, 'items');
          const itemId = await checkedTimes(() =>
            insertItem(items, {
              tripId,
              type: input.type,
              title: input.title,
              status: input.status ?? 'planned',
              start: input.start ?? null,
              end: input.end ?? null,
              visibility: input.visibility ?? 'shared',
              ownerMembershipId,
              tags: input.tags ?? [],
              // The creator owns the item, so may restrict its fields.
              restrictedFields: inFieldOrder(input.restrictedFields ?? []),
              createdBy,
            }),
          );
          await insertShares(items, { itemId, tripId, membershipIds: sharedWith, createdBy });
          const row = await findItem(items, itemId);
          if (!row) throw new Error(`item ${itemId} vanished inside its own write`);
          return {
            action: 'create',
            aggregate: 'item',
            entityId: itemId,
            tripId: loaded.tripId,
            version: row.version,
            snapshot: itemSnapshot(row, sharedWith),
            result: itemRecord(row, membership),
          };
        },
      });
    },

    async get(userId, itemId) {
      const { row, viewer } = await visibleItem(db, userId, itemId);
      return itemRecord(row, viewer);
    },

    async list(userId, tripId, query) {
      const viewer = await callerMembership(db, userId, tripId);
      // A trip the caller is not in does not exist for them.
      if (viewer === null) throw new ApiError('not_found');
      if (!canListItems(viewer.role)) throw new ApiError('forbidden');
      const rows = await listVisibleItems(forModule(db, 'items'), userId, tripId, {
        filter: {
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          ...(query.assignee === 'me' ? { assigneeMembershipId: viewer.id } : {}),
        },
        limit: query.limit + 1,
        after: query.cursor === undefined ? null : uuidCursor(query.cursor),
      });
      const shown = page(rows, query.limit, (row) => [row.id]);
      return {
        items: shown.rows.map((row) => itemRecord(row, viewer)),
        nextCursor: shown.nextCursor,
      };
    },

    update(ctx, itemId, body, ifMatch) {
      return write(ctx, {
        operation: itemsUpdate,
        target: { itemId },
        body,
        ifMatch,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canUpdateItem(acting.editor)) throw new ApiError('forbidden');
          return acting;
        },
        load: lockedItem,
        mutate: async (tx, _c, { row }, patch, acting) => {
          const { userId, membership, editor } = acting;
          const visibility = patch.visibility ?? (row.visibility as ItemRecord['visibility']);
          const narrows =
            visibility !== 'shared' &&
            (visibility !== row.visibility || patch.sharedWith !== undefined);
          if (narrows && !canNarrowVisibility(editor)) throw new ApiError('forbidden');
          if (!seesRestrictedFields(editor)) {
            if (patch.restrictedFields !== undefined) throw new ApiError('forbidden');
            // Only callers who see the restricted fields change the set, so it is the row's.
            if (
              row.restricted_fields.some((field) => patch[field as ItemMaskedField] !== undefined)
            ) {
              throw new ApiError('masked_field_write');
            }
          }
          if (patch.sharedWith !== undefined && visibility !== 'selected') {
            throw invalid('/sharedWith', 'sharedWith needs visibility selected');
          }
          const timeProblem = itemTimeProblem(
            patch.start === undefined ? startOf(row) : patch.start,
            patch.end === undefined ? endOf(row) : patch.end,
          );
          if (timeProblem !== null) throw invalid('/end', timeProblem);

          const items = forModule(tx, 'items');
          let sharedWith: string[] = [];
          if (patch.sharedWith !== undefined) {
            sharedWith = await tripMemberships(tx, row.trip_id, patch.sharedWith);
          } else if (visibility === 'selected') {
            sharedWith = await listShares(items, row.id);
          }
          const sealed = (column: string, value: string | null) =>
            value === null ? null : seal(keys, sealedField(row.id, column), value);
          const { cost, bookingRef, cardLast4 } = patch;
          await checkedTimes(() =>
            updateItem(
              items,
              row.id,
              {
                ...(patch.title === undefined ? {} : { title: patch.title }),
                ...(patch.status === undefined ? {} : { status: patch.status }),
                ...(patch.start === undefined ? {} : { start: patch.start }),
                ...(patch.end === undefined ? {} : { end: patch.end }),
                ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
                ...(patch.tags === undefined ? {} : { tags: patch.tags }),
                ...(cost === undefined ? {} : { cost: unmasked(cost) }),
                ...(bookingRef === undefined
                  ? {}
                  : { bookingRefEnc: sealed(SEALED_COLUMN.bookingRef, unmasked(bookingRef)) }),
                ...(cardLast4 === undefined
                  ? {}
                  : { cardLast4Enc: sealed(SEALED_COLUMN.cardLast4, unmasked(cardLast4)) }),
                ...(patch.restrictedFields === undefined
                  ? {}
                  : { restrictedFields: inFieldOrder(patch.restrictedFields) }),
              },
              userId,
            ),
          );
          // Shares are owned rows: replaced whole, and gone once the item leaves `selected`.
          if (patch.sharedWith !== undefined || visibility !== 'selected') {
            await replaceShares(items, {
              itemId: row.id,
              tripId: row.trip_id,
              membershipIds: sharedWith,
              createdBy: userId,
            });
          }
          const updated = await findItem(items, row.id);
          if (!updated) throw new Error(`item ${row.id} vanished inside its own write`);
          return {
            action: 'update',
            aggregate: 'item',
            entityId: row.id,
            tripId: row.trip_id,
            version: updated.version,
            snapshot: itemSnapshot(updated, sharedWith),
            result: itemRecord(updated, membership),
          };
        },
      });
    },

    // Not the write path: a reveal changes nothing and has no counter, and an archived
    // trip still allows it. It runs in one transaction so the event and the answer go together.
    reveal: (ctx, itemId, body) =>
      db.transaction().execute(async (tx) => {
        const { row, editor } = await actingEditor(tx, ctx, itemId);
        if (!canRevealItem(editor)) throw new ApiError('forbidden');
        const { fields } = validate(ItemRevealInput, body);
        await recordEvent(tx, ctx, {
          action: 'reveal',
          entityType: 'item',
          entityId: row.id,
          tripId: row.trip_id,
          reason: fields.map((f) => `/${f}`).join(','),
        });
        const shown: ItemReveal = {};
        for (const f of fields) {
          const column = SEALED_COLUMN[f];
          const enc = row[column];
          shown[f] = enc === null ? null : open(keys, sealedField(row.id, column), enc).toString();
        }
        return shown;
      }),

    rsvp(ctx, itemId, body) {
      return write(ctx, {
        operation: itemsRsvp,
        target: { itemId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canRsvpItem(acting.membership.role)) throw new ApiError('forbidden');
          return acting;
        },
        // The item lock serialises board writes; the counter is the board's, not the item's.
        load: async (tx, target) => {
          const { row, tripId } = await lockedItem(tx, target);
          return { tripId, counter: row.board_version, row };
        },
        mutate: async (tx, _c, { row }, input, acting) => {
          const items = forModule(tx, 'items');
          const membershipId = acting.membership.id;
          await upsertRsvp(items, {
            tripId: row.trip_id,
            itemId: row.id,
            membershipId,
            answer: input.rsvp,
            createdBy: acting.userId,
          });
          const boardVersion = await bumpBoardVersion(items, row.id);
          return {
            action: 'update',
            aggregate: 'item_board',
            entityId: row.id,
            tripId: row.trip_id,
            version: boardVersion,
            snapshot: boardSnapshot(await listBoard(items, row.id)),
            result: { itemId: row.id, membershipId, rsvp: input.rsvp, boardVersion },
          };
        },
      });
    },

    delete(ctx, itemId, body, ifMatch) {
      return write(ctx, {
        operation: itemsDelete,
        target: { itemId },
        body,
        ifMatch,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canDeleteItem(acting.editor)) throw new ApiError('forbidden');
          return acting;
        },
        load: lockedItem,
        mutate: async (tx, _c, { row }, _input, acting) => {
          const items = forModule(tx, 'items');
          const version = await softDeleteItem(items, row.id, acting.userId);
          return {
            action: 'delete',
            aggregate: 'item',
            entityId: row.id,
            tripId: row.trip_id,
            version,
            // The item as it was: restore copies this snapshot forward.
            snapshot: itemSnapshot(row, await listShares(items, row.id)),
            result: undefined,
          };
        },
      });
    },
  };
}

/**
 * The trip of an item this account may see (tribo.item_visible), or null: what a child of
 * an item kept by another module (a file) checks before attaching to it.
 */
export async function visibleItemTrip(
  db: Kysely<DB>,
  userId: string,
  itemId: string,
): Promise<string | null> {
  return (await findVisibleItem(forModule(db, 'items'), userId, itemId))?.trip_id ?? null;
}

/** The items side of members.remove and of a rejoin (R32), as the members service takes it. */
export const memberItems = { leave: removeMemberFromItems, rejoin: restoreMemberItems };

/**
 * R32, the items side of a member's removal, in the removal's transaction: the member's
 * rows leave every board of the trip (items the caller cannot see and deleted ones
 * included), each changed board bumps its boardVersion with its own snapshot, and the
 * private items the member owns, which nobody else could see, are soft-deleted. Returns
 * the records for the caller's write to store.
 */
async function removeMemberFromItems(tx: Tx, move: MemberMove): Promise<WriteRecord[]> {
  const items = forModule(tx, 'items');
  const records: WriteRecord[] = [];
  for (const board of await lockBoardsWith(items, move.tripId, move.membershipId)) {
    // eslint-disable-next-line no-await-in-loop -- each board's snapshot follows its own change
    await deleteMemberAllocations(items, board.id, move.membershipId);
    // eslint-disable-next-line no-await-in-loop -- as above
    const boardVersion = await bumpBoardVersion(items, board.id);
    records.push({
      action: 'update',
      aggregate: 'item_board',
      entityId: board.id,
      tripId: move.tripId,
      versionBefore: board.board_version,
      version: boardVersion,
      // eslint-disable-next-line no-await-in-loop -- as above
      snapshot: boardSnapshot(await listBoard(items, board.id)),
    });
  }
  for (const row of await lockPrivateItemsOf(items, move.tripId, move.membershipId)) {
    // eslint-disable-next-line no-await-in-loop -- each item's snapshot follows its own change
    const version = await softDeleteItem(items, row.id, move.userId);
    records.push({
      action: 'delete',
      aggregate: 'item',
      entityId: row.id,
      tripId: move.tripId,
      versionBefore: row.version,
      version,
      // The item as it was, as items.delete keeps it.
      // eslint-disable-next-line no-await-in-loop -- as above
      snapshot: itemSnapshot(row, await listShares(items, row.id)),
    });
  }
  return records;
}

/**
 * R32, the items side of a rejoin: the private items the member's latest removal
 * soft-deleted (found by that removal's request id in the audit log) come back, as long
 * as they are still the member's own private items. Items deleted any other way stay
 * deleted. Returns the records for the caller's write to store.
 */
async function restoreMemberItems(tx: Tx, move: MemberMove): Promise<WriteRecord[]> {
  const items = forModule(tx, 'items');
  const removed = await deletedWithEntity(
    tx,
    { entityType: 'membership', entityId: move.membershipId },
    'item',
  );
  const restored = await undeletePrivateItems(items, removed, {
    tripId: move.tripId,
    membershipId: move.membershipId,
    updatedBy: move.userId,
  });
  const records: WriteRecord[] = [];
  for (const id of restored) {
    // eslint-disable-next-line no-await-in-loop -- one item at a time, in id order
    const row = await findItem(items, id);
    if (!row) throw new Error(`item ${id} vanished inside its own restore`);
    records.push({
      action: 'restore',
      aggregate: 'item',
      entityId: id,
      tripId: move.tripId,
      versionBefore: row.version - 1,
      version: row.version,
      // eslint-disable-next-line no-await-in-loop -- as above
      snapshot: itemSnapshot(row, await listShares(items, id)),
    });
  }
  return records;
}

/** sharedWith as membership uuids, unique and sorted; each must be active in the trip. */
async function tripMemberships(
  tx: Tx,
  tripId: string,
  typeIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(typeIds.map((id) => decodeTypeId(ID_PREFIX.membership, id)))].sort();
  if (!(await allActiveMemberships(tx, tripId, ids))) {
    throw invalid('/sharedWith', 'not a member of this trip');
  }
  return ids;
}

/**
 * A patch value that is not the masked rendering: that stands for what the caller was
 * shown, not for a value, so writing it back is refused.
 */
function unmasked<T extends object | string>(value: T | null): Exclude<T, MaskedValue> | null {
  if (value !== null && typeof value === 'object' && 'masked' in value) {
    throw new ApiError('masked_field_write');
  }
  return value as Exclude<T, MaskedValue> | null;
}

/** A timed end before its start is only known once PostgreSQL has resolved both zones. */
function checkedTimes<T>(insert: () => Promise<T>): Promise<T> {
  return insert().catch((error: unknown) =>
    onConstraint(error, {
      items_time_order: () => invalid('/end', 'the item ends before it starts'),
    }),
  );
}

/** Every stored field and the owned shares; ciphertext stays ciphertext (Audit and versioning). */
function itemSnapshot(row: ItemRow, sharedWith: readonly string[]) {
  const stored = (at: Date | null, tz: string | null, date: string | null) => {
    if (at !== null && tz !== null) return { at: at.toISOString(), tz };
    return date === null ? null : { date };
  };
  return {
    type: row.type,
    title: row.title,
    status: row.status,
    start: stored(row.start_at, row.start_tz, row.start_date),
    end: stored(row.end_at, row.end_tz, row.end_date),
    visibility: row.visibility,
    ownerMembershipId: row.owner_membership_id,
    tags: row.tags,
    cost:
      row.cost_minor === null
        ? null
        : { amountMinor: Number(row.cost_minor), currency: row.cost_currency },
    bookingRefEnc: row.booking_ref_enc?.toString('base64') ?? null,
    cardLast4Enc: row.card_last4_enc?.toString('base64') ?? null,
    restrictedFields: [...row.restricted_fields],
    sharedWith: [...sharedWith],
  };
}
