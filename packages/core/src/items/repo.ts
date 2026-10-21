import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';

/** The items module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type ItemsDb = ModuleDb<'items'>;

/** A timed value as written on the ground, or an all-day date. */
type StoredTime = { local: string; tz: string } | { date: string };

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
  restrictedFields: readonly ValueOf<'tribo.items.restricted_fields'>[];
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
      restricted_fields: [...item.restrictedFields],
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
      'i.restricted_fields',
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
  restrictedFields?: readonly ValueOf<'tribo.items.restricted_fields'>[];
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
      ...(changes.restrictedFields === undefined
        ? {}
        : { restricted_fields: [...changes.restrictedFields] }),
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

/**
 * Sets this membership's answer on its attendee row, adding the row when there is none.
 * Only that one row is written: the caller's other roles and everyone else's stay.
 */
export async function upsertRsvp(
  db: ItemsDb,
  rsvp: {
    tripId: string;
    itemId: string;
    membershipId: string;
    answer: ValueOf<'tribo.allocations.rsvp'>;
    createdBy: string;
  },
): Promise<void> {
  await db
    .insertInto('tribo.allocations')
    .values({
      trip_id: rsvp.tripId,
      item_id: rsvp.itemId,
      membership_id: rsvp.membershipId,
      role: 'attendee',
      rsvp: rsvp.answer,
      created_by: rsvp.createdBy,
    })
    .onConflict((oc) =>
      oc
        .columns(['item_id', 'membership_id', 'role'])
        .where('role', 'in', ['attendee', 'assignee'])
        .doUpdateSet({ rsvp: rsvp.answer }),
    )
    .execute();
}

/** Bumps the item's board counter (R26), never its version; returns the new board_version. */
export async function bumpBoardVersion(db: ItemsDb, itemId: string): Promise<number> {
  const row = await db
    .updateTable('tribo.items')
    .set((eb) => ({ board_version: eb('board_version', '+', 1) }))
    .where('id', '=', itemId)
    .returning('board_version')
    .executeTakeFirstOrThrow();
  return row.board_version;
}

/** Every row of an item's assignment board, in a stable order. */
export function listBoard(db: ItemsDb, itemId: string) {
  return db
    .selectFrom('tribo.allocations')
    .select(['membership_id', 'unit_id', 'role', 'rsvp'])
    .where('item_id', '=', itemId)
    .orderBy('membership_id')
    .orderBy('role')
    .orderBy('unit_id')
    .execute();
}

/** A unit's columns; only live units (soft-deleted ones drop out of every read). */
function selectUnit(db: ItemsDb) {
  return db
    .selectFrom('tribo.units as u')
    .select([
      'u.id',
      'u.item_id',
      'u.kind',
      'u.label',
      'u.capacity',
      'u.bed_type',
      'u.rate_minor',
      'u.rate_currency',
      'u.position',
      'u.version',
      'u.created_at',
      'u.updated_at',
    ])
    .where('u.deleted_at', 'is', null);
}

export interface NewUnit {
  itemId: string;
  kind: ValueOf<'tribo.units.kind'>;
  label: string;
  capacity: number;
  bedType: string | null;
  rate: { amountMinor: number; currency: string } | null;
  position: number;
  createdBy: string;
}

export async function insertUnit(db: ItemsDb, unit: NewUnit): Promise<string> {
  const row = await db
    .insertInto('tribo.units')
    .values({
      item_id: unit.itemId,
      kind: unit.kind,
      label: unit.label,
      capacity: unit.capacity,
      bed_type: unit.bedType,
      rate_minor: unit.rate?.amountMinor ?? null,
      rate_currency: unit.rate?.currency ?? null,
      position: unit.position,
      created_by: unit.createdBy,
      updated_by: unit.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** For the writer that just changed it, inside its transaction. */
export function findUnit(db: ItemsDb, unitId: string) {
  return selectUnit(db).where('u.id', '=', unitId).executeTakeFirst();
}

/** The item a live unit belongs to, or undefined; whether the caller sees it is not asked here. */
export async function findUnitItemId(db: ItemsDb, unitId: string): Promise<string | undefined> {
  const row = await selectUnit(db).where('u.id', '=', unitId).executeTakeFirst();
  return row?.item_id;
}

/** The live unit, locked FOR UPDATE until the write commits. */
export function lockUnit(db: ItemsDb, unitId: string) {
  return selectUnit(db).where('u.id', '=', unitId).forUpdate().executeTakeFirst();
}

/** What a units.update changes; an absent key keeps its column. */
export interface UnitChanges {
  label?: string;
  capacity?: number;
  bedType?: string | null;
  rate?: { amountMinor: number; currency: string } | null;
  position?: number;
}

/** Applies the changes and bumps the unit's version. */
export async function updateUnit(
  db: ItemsDb,
  unitId: string,
  changes: UnitChanges,
  updatedBy: string,
): Promise<void> {
  const { rate } = changes;
  await db
    .updateTable('tribo.units')
    .set((eb) => ({
      ...(changes.label === undefined ? {} : { label: changes.label }),
      ...(changes.capacity === undefined ? {} : { capacity: changes.capacity }),
      ...(changes.bedType === undefined ? {} : { bed_type: changes.bedType }),
      ...(rate === undefined
        ? {}
        : { rate_minor: rate?.amountMinor ?? null, rate_currency: rate?.currency ?? null }),
      ...(changes.position === undefined ? {} : { position: changes.position }),
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
      updated_by: updatedBy,
    }))
    .where('id', '=', unitId)
    .execute();
}

/** Stamps deleted_at and bumps the version; returns the new version. */
export async function softDeleteUnit(
  db: ItemsDb,
  unitId: string,
  deletedBy: string,
): Promise<number> {
  const row = await db
    .updateTable('tribo.units')
    .set((eb) => ({
      deleted_at: sql<Date>`now()`,
      deleted_by: deletedBy,
      updated_at: sql<Date>`now()`,
      updated_by: deletedBy,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', unitId)
    .returning('version')
    .executeTakeFirstOrThrow();
  return row.version;
}

/** Deletes the board rows in one unit: units are soft-deleted, so nothing cascades (R21). */
export async function deleteUnitAllocations(db: ItemsDb, unitId: string): Promise<void> {
  await db.deleteFrom('tribo.allocations').where('unit_id', '=', unitId).execute();
}

/** The board rows that take a place in the unit: occupants, its driver and passengers. */
export async function countSeated(db: ItemsDb, unitId: string): Promise<number> {
  const row = await db
    .selectFrom('tribo.allocations')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('unit_id', '=', unitId)
    .where('role', 'in', ['occupant', 'driver', 'passenger'])
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * One page of an item's live units in id order (UUIDv7, so the order they were added).
 * The caller has already found the item visible.
 */
export function listUnits(
  db: ItemsDb,
  itemId: string,
  page: { limit: number; after: string | null },
) {
  let query = selectUnit(db).where('u.item_id', '=', itemId);
  if (page.after !== null) query = query.where('u.id', '>', page.after);
  return query.orderBy('u.id').limit(page.limit).execute();
}

export type UnitRow = NonNullable<Awaited<ReturnType<typeof findUnit>>>;
