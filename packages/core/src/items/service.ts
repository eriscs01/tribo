import {
  decodeTypeId,
  ID_PREFIX,
  ItemInput,
  itemTimeProblem,
  ItemPatch,
  Uuid,
  type ItemListQuery,
  type MaskedValue,
} from '@tribo/contract';
import { seal, type Keyring } from '@tribo/crypto';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  ApiError,
  decodeCursor,
  encodeCursor,
  invalidCursor,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { allActiveMemberships, callerMembership, type CallerMembership } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import {
  canCreateItem,
  canListItems,
  canNarrowVisibility,
  canUpdateItem,
  type ItemEditor,
} from './policy.js';
import {
  findItem,
  findVisibleItem,
  insertItem,
  insertShares,
  isAssignee,
  listShares,
  listVisibleItems,
  lockItem,
  replaceShares,
  updateItem,
  type ItemRow,
} from './repo.js';

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
  /** The booked price, or 'masked' for a caller who may not read costs. */
  cost: { amountMinor: number; currency: string } | 'masked' | null;
  /** Whether a booking ref or card last-4 is stored; their values are masked for every reader. */
  hasBookingRef: boolean;
  hasCardLast4: boolean;
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
}

const itemsCreate = writeOperation('items.create', ItemInput);
const itemsUpdate = writeOperation('items.update', ItemPatch);

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
      const row = await findVisibleItem(forModule(db, 'items'), userId, itemId);
      const viewer = row ? await callerMembership(db, userId, row.trip_id) : null;
      if (!row || !viewer) throw new ApiError('not_found');
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
        after: query.cursor === undefined ? null : itemCursor(query.cursor),
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
            value === null ? null : seal(keys, { table: 'items', column, rowId: row.id }, value);
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
                  : { bookingRefEnc: sealed('booking_ref_enc', unmasked(bookingRef)) }),
                ...(cardLast4 === undefined
                  ? {}
                  : { cardLast4Enc: sealed('card_last4_enc', unmasked(cardLast4)) }),
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
  };
}

/** The caller acting on one item they can see: account, membership and standing on it. */
interface ActingEditor {
  userId: string;
  membership: CallerMembership;
  editor: ItemEditor;
}

/**
 * Who is acting on an item. An item the caller cannot see (tribo.item_visible) does not
 * exist for them.
 */
async function actingEditor(tx: Tx, ctx: RequestContext, itemId: string): Promise<ActingEditor> {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  const items = forModule(tx, 'items');
  const row = await findVisibleItem(items, ctx.userId, itemId);
  const membership = row ? await callerMembership(tx, ctx.userId, row.trip_id) : null;
  if (!row || !membership) throw new ApiError('not_found');
  const owns = row.owner_membership_id === membership.id;
  const assigned = !owns && (await isAssignee(items, row.id, membership.id));
  return { userId: ctx.userId, membership, editor: { role: membership.role, owns, assigned } };
}

/** The write path's load for one item: the live row, locked until commit. */
async function lockedItem(tx: Tx, target: { itemId: string }) {
  const row = await lockItem(forModule(tx, 'items'), target.itemId);
  if (!row) throw new ApiError('not_found');
  return { tripId: row.trip_id, counter: row.version, row };
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

function invalid(path: string, message: string): ApiError {
  return new ApiError('validation_failed', { errors: [{ path, message }] });
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

/** An items.list cursor's sort key; anything else is refused before it reaches SQL. */
function itemCursor(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  const key = Uuid.safeParse(id);
  if (!key.success) throw invalidCursor();
  return key.data;
}

function startOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.start_at, row.start_tz, row.start_local, row.start_date);
}

function endOf(row: ItemRow): ItemTimeRecord | null {
  return time(row.end_at, row.end_tz, row.end_local, row.end_date);
}

/** The item as this caller reads it: sensitive values masked for all, costs per canViewCosts. */
function itemRecord(row: ItemRow, viewer: Pick<CallerMembership, 'canViewCosts'>): ItemRecord {
  const cost =
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
    cost: cost !== null && !viewer.canViewCosts ? 'masked' : cost,
    hasBookingRef: row.booking_ref_enc !== null,
    hasCardLast4: row.card_last4_enc !== null,
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
    sharedWith: [...sharedWith],
  };
}
