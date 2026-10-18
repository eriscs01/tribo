import { decodeTypeId, ID_PREFIX, ItemInput } from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import { ApiError, type RequestContext, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { allActiveMemberships, callerMembership } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import { canCreateItem } from './policy.js';
import { findItem, findVisibleItem, insertItem, insertShares, type ItemRow } from './repo.js';

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
}

const itemsCreate = writeOperation('items.create', ItemInput);

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createItemsService(db: Kysely<DB>, write: WritePath): ItemsService {
  return {
    create(ctx, tripId, body) {
      /** Who authorize found: the acting account and its membership, which owns the item. */
      let owner: { userId: string; membershipId: string } | undefined;
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
          owner = { userId: c.userId, membershipId: membership.id };
        },
        load: (_tx, target) => Promise.resolve({ tripId: target.tripId }),
        mutate: async (tx, _c, loaded, input) => {
          if (!owner) throw new Error('items.create mutated before authorize');
          const { userId: createdBy, membershipId: ownerMembershipId } = owner;
          const sharedWith = [
            ...new Set(
              (input.sharedWith ?? []).map((id) => decodeTypeId(ID_PREFIX.membership, id)),
            ),
          ].sort();
          if (!(await allActiveMemberships(tx, tripId, sharedWith))) {
            throw new ApiError('validation_failed', {
              errors: [{ path: '/sharedWith', message: 'not a member of this trip' }],
            });
          }
          const items = forModule(tx, 'items');
          const itemId = await insertChecked(() =>
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
          const record = itemRecord(row);
          return {
            action: 'create',
            aggregate: 'item',
            entityId: itemId,
            tripId: loaded.tripId,
            version: record.version,
            snapshot: itemSnapshot(record, sharedWith),
            result: record,
          };
        },
      });
    },

    async get(userId, itemId) {
      const row = await findVisibleItem(forModule(db, 'items'), userId, itemId);
      if (!row) throw new ApiError('not_found');
      return itemRecord(row);
    },
  };
}

/** A timed end before its start is only known once PostgreSQL has resolved both zones. */
async function insertChecked<T>(insert: () => Promise<T>): Promise<T> {
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

function itemRecord(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type as ItemRecord['type'],
    title: row.title,
    status: row.status as ItemRecord['status'],
    start: time(row.start_at, row.start_tz, row.start_local, row.start_date),
    end: time(row.end_at, row.end_tz, row.end_local, row.end_date),
    visibility: row.visibility as ItemRecord['visibility'],
    ownerMembershipId: row.owner_membership_id,
    tags: row.tags,
    version: row.version,
    boardVersion: row.board_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The item's fields and its owned shares; ciphertext columns join as ciphertext later. */
function itemSnapshot(item: ItemRecord, sharedWith: readonly string[]) {
  const stored = (t: ItemTimeRecord | null) =>
    t === null ? null : 'date' in t ? { date: t.date } : { at: t.at.toISOString(), tz: t.tz };
  return {
    type: item.type,
    title: item.title,
    status: item.status,
    start: stored(item.start),
    end: stored(item.end),
    visibility: item.visibility,
    ownerMembershipId: item.ownerMembershipId,
    tags: item.tags,
    sharedWith: [...sharedWith],
  };
}
