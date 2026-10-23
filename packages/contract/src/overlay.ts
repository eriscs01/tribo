// Overlay schemas: a member's private note, reminder and checklist on an item (Technical
// design, "Who sees what"). Always private to the membership that wrote it.
import * as z from 'zod';
import { ID_PREFIX, typeId } from './ids.js';
import { Instant } from './time.js';

/** One line of an overlay's own checklist. */
export const OverlayChecklistEntry = z
  .strictObject({
    text: z.string().trim().min(1).max(200),
    done: z.boolean(),
  })
  .meta({ id: 'OverlayChecklistEntry' });

export type OverlayChecklistEntry = z.infer<typeof OverlayChecklistEntry>;

/** The most lines a checklist holds. */
export const OVERLAY_CHECKLIST_MAX = 50;

/** The longest note. */
export const OVERLAY_NOTE_MAX = 4000;

/**
 * overlays.put: the whole overlay, replaced. A field left out is empty: no note, no
 * reminder, no checklist.
 */
export const OverlayInput = z
  .strictObject({
    note: z.string().max(OVERLAY_NOTE_MAX).nullable().optional(),
    /** When the in-app "Due soon" list starts showing the item (F-08); nothing is pushed in 1a. */
    reminderAt: Instant.nullable().optional(),
    checklist: z.array(OverlayChecklistEntry).max(OVERLAY_CHECKLIST_MAX).optional(),
  })
  .meta({ id: 'OverlayInput' });

export type OverlayInput = z.infer<typeof OverlayInput>;

/**
 * The caller's own overlay on one item, as overlays.get and overlays.put answer it. There
 * is at most one per member and item, so the item names it; no one else is ever shown one.
 */
export const Overlay = z
  .strictObject({
    itemId: typeId(ID_PREFIX.item),
    tripId: typeId(ID_PREFIX.trip),
    note: z.string().nullable(),
    reminderAt: Instant.nullable(),
    checklist: z.array(OverlayChecklistEntry),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Overlay' });

export type Overlay = z.infer<typeof Overlay>;
