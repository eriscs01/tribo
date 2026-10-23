// The overlays table: one live row per member and item, private to that membership. Every
// query here takes the membership it is for, so no read can reach another member's row.
import type { Json } from '@tribo/db';
import { sql } from 'kysely';
import type { ItemsDb } from './repo.js';

const OVERLAY_COLUMNS = [
  'id',
  'trip_id',
  'item_id',
  'membership_id',
  'note',
  'reminder_at',
  'checklist',
  'version',
  'created_at',
  'updated_at',
] as const;

export type OverlayRow = Awaited<ReturnType<typeof findOverlay>> & object;

/** The membership's live overlay on the item, or undefined. */
export function findOverlay(db: ItemsDb, itemId: string, membershipId: string) {
  return db
    .selectFrom('tribo.overlays')
    .select(OVERLAY_COLUMNS)
    .where('item_id', '=', itemId)
    .where('membership_id', '=', membershipId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/**
 * The membership's live overlays in the trip on items this account sees (tribo.item_visible),
 * in item order, the first `limit` of them: the offline bundle's own overlays.
 */
export function listMemberOverlays(
  db: ItemsDb,
  reader: { userId: string; membershipId: string },
  tripId: string,
  limit: number,
) {
  return db
    .selectFrom('tribo.overlays')
    .select(OVERLAY_COLUMNS)
    .where('trip_id', '=', tripId)
    .where('membership_id', '=', reader.membershipId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`tribo.item_visible(${reader.userId}, item_id)`)
    .orderBy('item_id')
    .limit(limit)
    .execute();
}

/** As findOverlay, locked until commit. */
export function lockOverlay(db: ItemsDb, itemId: string, membershipId: string) {
  return db
    .selectFrom('tribo.overlays')
    .select(OVERLAY_COLUMNS)
    .where('item_id', '=', itemId)
    .where('membership_id', '=', membershipId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
}

/** What an overlay holds besides whose it is and where. */
interface OverlayContent {
  note: string | null;
  reminderAt: Date | null;
  checklist: Json;
}

/** Writes the membership's first overlay on the item; the unique index refuses a second live one. */
export function insertOverlay(
  db: ItemsDb,
  overlay: OverlayContent & { tripId: string; itemId: string; membershipId: string },
) {
  return db
    .insertInto('tribo.overlays')
    .values({
      trip_id: overlay.tripId,
      item_id: overlay.itemId,
      membership_id: overlay.membershipId,
      note: overlay.note,
      reminder_at: overlay.reminderAt,
      checklist: JSON.stringify(overlay.checklist),
    })
    .returning(OVERLAY_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** Replaces the overlay's content whole and bumps its version. */
export function replaceOverlay(db: ItemsDb, overlayId: string, content: OverlayContent) {
  return db
    .updateTable('tribo.overlays')
    .set((eb) => ({
      note: content.note,
      reminder_at: content.reminderAt,
      checklist: JSON.stringify(content.checklist),
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
    }))
    .where('id', '=', overlayId)
    .returning(OVERLAY_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** Stamps deleted_at and bumps the version; a new overlay may follow, the unique index counts live rows only. */
export function softDeleteOverlay(db: ItemsDb, overlayId: string) {
  return db
    .updateTable('tribo.overlays')
    .set((eb) => ({
      deleted_at: sql<Date>`now()`,
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
    }))
    .where('id', '=', overlayId)
    .returning(OVERLAY_COLUMNS)
    .executeTakeFirstOrThrow();
}

/**
 * The reminders these memberships set that fall in the window, on items this account sees
 * (tribo.item_visible), soonest first. The memberships are the caller's own and nobody
 * else's: that is the one thing an overlay is scoped by.
 */
export function listReminders(
  db: ItemsDb,
  userId: string,
  membershipIds: readonly string[],
  window: { from: Date; to: Date },
) {
  if (membershipIds.length === 0) return Promise.resolve([]);
  return db
    .selectFrom('tribo.overlays')
    .select(['item_id', 'membership_id', 'reminder_at'])
    .where('membership_id', 'in', membershipIds)
    .where('deleted_at', 'is', null)
    .where('reminder_at', '>=', window.from)
    .where('reminder_at', '<=', window.to)
    .where(sql<boolean>`tribo.item_visible(${userId}, item_id)`)
    .orderBy('reminder_at')
    .orderBy('item_id')
    .execute();
}
