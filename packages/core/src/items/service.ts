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
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  ApiError,
  encodeCursor,
  type RequestContext,
  type Tx,
  validate,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent } from '../audit/service.js';
import { allActiveMemberships, callerMembership, type CallerMembership } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import {
  actingEditor,
  boardSnapshot,
  idCursor,
  invalid,
  lockedItem,
  moneyView,
  restrictedHidden,
  visibleItem,
  type ActingEditor,
} from './acting.js';
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
  findItem,
  insertItem,
  insertShares,
  listBoard,
  listShares,
  listVisibleItems,
  replaceShares,
  softDeleteItem,
  updateItem,
  upsertRsvp,
  type ItemRow,
} from './repo.js';

export {
  createUnitsService,
  type AllocationRecord,
  type BoardRecord,
  type UnitRecord,
  type UnitsService,
} from './units.js';

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
      /** Who authorize found: the acting account and its membership, which owns the item. */
      let owner: { userId: string; membership: CallerMembership } | undefined;
      return write(ctx, {
        operation: itemsCreate,
        target: { tripId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          if (c.userId === null) throw new ApiError('unauthenticated');
          const membership = await callerMembership(tx, c.userId, target.tripId);
          // A trip the caller is not in does not exist for them.
          if (membership === null) throw new ApiError('not_found');
          if (!canCreateItem(membership.role)) throw new ApiError('forbidden');
          owner = { userId: c.userId, membership };
        },
        load: (_tx, target) => Promise.resolve({ tripId: target.tripId }),
        mutate: async (tx, _c, loaded, input) => {
          if (!owner) throw new Error('items.create mutated before authorize');
          const { userId: createdBy, membership } = owner;
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
      // One extra row says whether another page follows.
      const rows = await listVisibleItems(forModule(db, 'items'), userId, tripId, {
        filter: {
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          ...(query.assignee === 'me' ? { assigneeMembershipId: viewer.id } : {}),
        },
        limit: query.limit + 1,
        after: query.cursor === undefined ? null : idCursor(query.cursor),
      });
      const items = rows.slice(0, query.limit).map((row) => itemRecord(row, viewer));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > query.limit && last ? encodeCursor([last.id]) : null,
      };
    },

    update(ctx, itemId, body, ifMatch) {
      let acting: ActingEditor | undefined;
      return write(ctx, {
        operation: itemsUpdate,
        target: { itemId },
        body,
        ifMatch,
        authorize: async (tx, c, target) => {
          acting = await actingEditor(tx, c, target.itemId);
          if (!canUpdateItem(acting.editor)) throw new ApiError('forbidden');
        },
        load: lockedItem,
        mutate: async (tx, _c, { row }, patch) => {
          if (!acting) throw new Error('items.update mutated before authorize');
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
      let acting: ActingEditor | undefined;
      return write(ctx, {
        operation: itemsRsvp,
        target: { itemId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          acting = await actingEditor(tx, c, target.itemId);
          if (!canRsvpItem(acting.membership.role)) throw new ApiError('forbidden');
        },
        // The item lock serialises board writes; the counter is the board's, not the item's.
        load: async (tx, target) => {
          const { row, tripId } = await lockedItem(tx, target);
          return { tripId, counter: row.board_version, row };
        },
        mutate: async (tx, _c, { row }, input) => {
          if (!acting) throw new Error('items.rsvp mutated before authorize');
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
      let acting: ActingEditor | undefined;
      return write(ctx, {
        operation: itemsDelete,
        target: { itemId },
        body,
        ifMatch,
        authorize: async (tx, c, target) => {
          acting = await actingEditor(tx, c, target.itemId);
          if (!canDeleteItem(acting.editor)) throw new ApiError('forbidden');
        },
        load: lockedItem,
        mutate: async (tx, _c, { row }) => {
          if (!acting) throw new Error('items.delete mutated before authorize');
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
async function checkedTimes<T>(insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (
      error instanceof Error &&
      'constraint' in error &&
      error.constraint === 'items_time_order'
    ) {
      throw new ApiError('validation_failed', {
        errors: [{ path: '/end', message: 'the item ends before it starts' }],
      });
    }
    throw error;
  }
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

function startOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.start_at, row.start_tz, row.start_local, row.start_date);
}

function endOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.end_at, row.end_tz, row.end_local, row.end_date);
}

/** A set of maskable fields in the closed set's own order, whatever order it came in. */
function inFieldOrder(fields: readonly string[]): ItemMaskedField[] {
  return ItemMaskedField.options.filter((f) => fields.includes(f));
}

/**
 * The item as this caller reads it, the one serializer every item read goes through:
 * sensitive values masked for all, costs per canViewCosts, and restricted fields masked,
 * present or not, for every caller but the item's owner and the trip's owners and organizers.
 */
function itemRecord(
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
