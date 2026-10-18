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
      'i.version',
      'i.board_version',
      'i.created_at',
      'i.updated_at',
    ])
    .where('i.deleted_at', 'is', null);
}

export type ItemRow = NonNullable<Awaited<ReturnType<typeof findItem>>>;

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
