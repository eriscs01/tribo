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
