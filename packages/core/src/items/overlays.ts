// The caller's own overlay on an item: a private note, reminder and checklist (Technical
// design, "Who sees what"). An overlay belongs to one membership and is read and written by
// it alone; every query takes the caller's membership, so no other member's can be reached.
import { type OverlayChecklistEntry } from '@tribo/contract';
import { forModule, type DB } from '@tribo/db';
import { ApiError, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { visibleItem } from './acting.js';
import { findOverlay, type OverlayRow } from './overlay-repo.js';
import { canGetOverlay } from './policy.js';

/** The caller's overlay on one item. */
export interface OverlayRecord {
  itemId: string;
  tripId: string;
  note: string | null;
  reminderAt: Date | null;
  checklist: OverlayChecklistEntry[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OverlaysService {
  /**
   * overlays.get: the caller's own overlay on an item they can see. A viewer keeps none
   * (forbidden). An item the caller cannot see, one that is deleted or unknown, and an
   * item with no overlay of theirs are not_found; another member's is never reached.
   */
  get(userId: string, itemId: string): Promise<OverlayRecord>;
}

function overlayRecord(row: OverlayRow): OverlayRecord {
  return {
    itemId: row.item_id,
    tripId: row.trip_id,
    note: row.note,
    reminderAt: row.reminder_at,
    checklist: row.checklist as OverlayChecklistEntry[],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createOverlaysService(db: Kysely<DB>, _write: WritePath): OverlaysService {
  return {
    async get(userId, itemId) {
      // The item first: one the caller cannot see does not exist for them, whatever their role.
      const { viewer } = await visibleItem(db, userId, itemId);
      if (!canGetOverlay(viewer.role)) throw new ApiError('forbidden');
      const row = await findOverlay(forModule(db, 'items'), itemId, viewer.id);
      if (!row) throw new ApiError('not_found');
      return overlayRecord(row);
    },
  };
}
