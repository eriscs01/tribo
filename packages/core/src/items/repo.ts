import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';

/** The items module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ItemsDb = ModuleDb<'items'>;

/** A timed value as written on the ground, or an all-day date. */
export type StoredTime = { local: string; tz: string } | { date: string };

export interface NewItem {
  tripId: string;
  type: ValueOf<'tribo.items.type'>;
  title: string;
  status: ValueOf<'tribo.items.status'>;
  start: StoredTime | null;
  end: StoredTime | null;
  visibility: ValueOf<'tribo.items.visibility'>;
  ownerMembershipId: string;
  tags: readonly string[];
  createdBy: string;
}

/** PostgreSQL resolves wall-clock time in its zone, so the tz database has one reader. */
const instant = (t: StoredTime | null) =>
  t !== null && 'local' in t ? sql<Date>`(${t.local}::timestamp AT TIME ZONE ${t.tz})` : null;
const zone = (t: StoredTime | null) => (t !== null && 'local' in t ? t.tz : null);
const day = (t: StoredTime | null) => (t !== null && 'date' in t ? t.date : null);

export async function insertItem(db: ItemsDb, item: NewItem): Promise<string> {
  const row = await db
    .insertInto('tribo.items')
    .values({
      trip_id: item.tripId,
      type: item.type,
      title: item.title,
      status: item.status,
      start_at: instant(item.start),
      start_tz: zone(item.start),
      end_at: instant(item.end),
      end_tz: zone(item.end),
      start_date: day(item.start),
      end_date: day(item.end),
      visibility: item.visibility,
      owner_membership_id: item.ownerMembershipId,
      tags: [...item.tags],
      created_by: item.createdBy,
      updated_by: item.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function insertShares(
  db: ItemsDb,
  share: { itemId: string; tripId: string; membershipIds: readonly string[]; createdBy: string },
): Promise<void> {
  if (share.membershipIds.length === 0) return;
  await db
    .insertInto('tribo.item_shares')
    .values(
      share.membershipIds.map((membershipId) => ({
        item_id: share.itemId,
        trip_id: share.tripId,
        membership_id: membershipId,
        created_by: share.createdBy,
      })),
    )
    .execute();
}

const LOCAL_FORMAT = 'YYYY-MM-DD"T"HH24:MI';

/** An item's common columns, times rendered in their own zones and dates as text. */
function selectItem(db: ItemsDb) {
  return db
    .selectFrom('tribo.items as i')
    .select([
      'i.id',
      'i.trip_id',
      'i.type',
      'i.title',
      'i.status',
      'i.start_at',
      'i.start_tz',
      sql<string | null>`to_char(i.start_at AT TIME ZONE i.start_tz, ${LOCAL_FORMAT})`.as(
        'start_local',
      ),
      'i.end_at',
      'i.end_tz',
      sql<string | null>`to_char(i.end_at AT TIME ZONE i.end_tz, ${LOCAL_FORMAT})`.as('end_local'),
      sql<string | null>`i.start_date::text`.as('start_date'),
      sql<string | null>`i.end_date::text`.as('end_date'),
      'i.visibility',
      'i.owner_membership_id',
      'i.tags',
      'i.cost_minor',
      'i.cost_currency',
      'i.booking_ref_enc',
      'i.card_last4_enc',
      'i.version',
      'i.board_version',
      'i.created_at',
      'i.updated_at',
    ])
    .where('i.deleted_at', 'is', null);
}

export type ItemRow = NonNullable<Awaited<ReturnType<typeof findItem>>>;

/** The live item, locked FOR UPDATE until the write commits. */
export function lockItem(db: ItemsDb, itemId: string) {
  return selectItem(db).where('i.id', '=', itemId).forUpdate().executeTakeFirst();
}

/** What an items.update changes; an absent key keeps its column. */
export interface ItemChanges {
  title?: string;
  status?: ValueOf<'tribo.items.status'>;
  start?: StoredTime | null;
  end?: StoredTime | null;
  visibility?: ValueOf<'tribo.items.visibility'>;
  tags?: readonly string[];
  cost?: { amountMinor: number; currency: string } | null;
  bookingRefEnc?: Buffer | null;
  cardLast4Enc?: Buffer | null;
}

/** Applies the changes and bumps the item's version, never its board_version (R26). */
export async function updateItem(
  db: ItemsDb,
  itemId: string,
  changes: ItemChanges,
  updatedBy: string,
): Promise<void> {
  const { start, end, cost } = changes;
  await db
    .updateTable('tribo.items')
    .set((eb) => ({
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      ...(start === undefined
        ? {}
        : { start_at: instant(start), start_tz: zone(start), start_date: day(start) }),
      ...(end === undefined ? {} : { end_at: instant(end), end_tz: zone(end), end_date: day(end) }),
      ...(changes.visibility === undefined ? {} : { visibility: changes.visibility }),
      ...(changes.tags === undefined ? {} : { tags: [...changes.tags] }),
      ...(cost === undefined
        ? {}
        : { cost_minor: cost?.amountMinor ?? null, cost_currency: cost?.currency ?? null }),
      ...(changes.bookingRefEnc === undefined ? {} : { booking_ref_enc: changes.bookingRefEnc }),
      ...(changes.cardLast4Enc === undefined ? {} : { card_last4_enc: changes.cardLast4Enc }),
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
      updated_by: updatedBy,
    }))
    .where('id', '=', itemId)
    .execute();
}

/**
 * Stamps deleted_at and bumps the version; the item's children need no stamp of their own,
 * since tribo.item_visible hides them with it. Returns the new version.
 */
export async function softDeleteItem(
  db: ItemsDb,
  itemId: string,
  deletedBy: string,
): Promise<number> {
  const row = await db
    .updateTable('tribo.items')
    .set((eb) => ({
      deleted_at: sql<Date>`now()`,
      deleted_by: deletedBy,
      updated_at: sql<Date>`now()`,
      updated_by: deletedBy,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', itemId)
    .returning('version')
    .executeTakeFirstOrThrow();
  return row.version;
}

/** The memberships an item is shared with, in id order. */
export async function listShares(db: ItemsDb, itemId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('tribo.item_shares')
    .select('membership_id')
    .where('item_id', '=', itemId)
    .orderBy('membership_id')
    .execute();
  return rows.map((r) => r.membership_id);
}

/** Replaces an item's shares whole (they are owned rows of the item). */
export async function replaceShares(
  db: ItemsDb,
  share: { itemId: string; tripId: string; membershipIds: readonly string[]; createdBy: string },
): Promise<void> {
  await db.deleteFrom('tribo.item_shares').where('item_id', '=', share.itemId).execute();
  await insertShares(db, share);
}

/** Whether this membership is an assignee on the item's board. */
export async function isAssignee(
  db: ItemsDb,
  itemId: string,
  membershipId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('tribo.allocations')
    .select('id')
    .where('item_id', '=', itemId)
    .where('membership_id', '=', membershipId)
    .where('role', '=', 'assignee')
    .executeTakeFirst();
  return row !== undefined;
}

/** For the writer that just created it, inside its transaction. */
export function findItem(db: ItemsDb, itemId: string) {
  return selectItem(db).where('i.id', '=', itemId).executeTakeFirst();
}

/** The item if tribo.item_visible lets this account see it (the one item predicate). */
export function findVisibleItem(db: ItemsDb, userId: string, itemId: string) {
  return selectItem(db)
    .where('i.id', '=', itemId)
    .where(sql<boolean>`tribo.item_visible(${userId}, i.id)`)
    .executeTakeFirst();
}

export interface ItemFilter {
  type?: ValueOf<'tribo.items.type'>;
  /** Inclusive day range; an item matches when its days, in its own zones, overlap it. */
  from?: string;
  to?: string;
  /** Only items this membership is an assignee of. */
  assigneeMembershipId?: string;
}

/** An item's first and last day, each in its own zone; null for an undated item. */
const firstDay = sql<string>`coalesce((i.start_at AT TIME ZONE i.start_tz)::date, i.start_date)`;
const lastDay = sql<string>`coalesce((i.end_at AT TIME ZONE i.end_tz)::date, i.end_date, ${firstDay})`;

/**
 * One page of a trip's items that tribo.item_visible lets this account see, in id order
 * (UUIDv7, so the order they were added). `after` is the last id of the previous page.
 */
export function listVisibleItems(
  db: ItemsDb,
  userId: string,
  tripId: string,
  page: { filter: ItemFilter; limit: number; after: string | null },
) {
  const { filter } = page;
  let query = selectItem(db)
    .where('i.trip_id', '=', tripId)
    .where(sql<boolean>`tribo.item_visible(${userId}, i.id)`);
  if (filter.type !== undefined) query = query.where('i.type', '=', filter.type);
  if (filter.from !== undefined)
    query = query.where(sql<boolean>`${lastDay} >= ${filter.from}::date`);
  if (filter.to !== undefined) query = query.where(sql<boolean>`${firstDay} <= ${filter.to}::date`);
  const assignee = filter.assigneeMembershipId;
  if (assignee !== undefined) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('tribo.allocations as a')
          .select('a.id')
          .whereRef('a.item_id', '=', 'i.id')
          .where('a.membership_id', '=', assignee)
          .where('a.role', '=', 'assignee'),
      ),
    );
  }
  if (page.after !== null) query = query.where('i.id', '>', page.after);
  return query.orderBy('i.id').limit(page.limit).execute();
}
