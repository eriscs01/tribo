// The overlays table: one live row per member and item, private to that membership. Every
// query here takes the membership it is for, so no read can reach another member's row.
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
