// The caller's own overlay on an item: a private note, reminder and checklist (Technical
// design, "Who sees what"). An overlay belongs to one membership and is read and written by
// it alone; every query takes the caller's membership, so no other member's can be reached.
import { OverlayInput, type OverlayChecklistEntry } from '@tribo/contract';
import { forModule, type DB } from '@tribo/db';
import {
  actingUser,
  ApiError,
  onConstraint,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { writeOperation } from '../write-operation.js';
import { visibleItem } from './acting.js';
import {
  findOverlay,
  insertOverlay,
  lockOverlay,
  replaceOverlay,
  type OverlayRow,
} from './overlay-repo.js';
import { canGetOverlay, canPutOverlay } from './policy.js';

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

/**
 * What overlays.put names to say which overlay it writes (G3): `createOnly` is
 * If-None-Match: *, `ifMatch` the version it replaces.
 */
interface OverlayPrecondition {
  ifMatch: number | undefined;
  createOnly: boolean;
}

export interface OverlaysService {
  /**
   * overlays.get: the caller's own overlay on an item they can see. A viewer keeps none
   * (forbidden). An item the caller cannot see, one that is deleted or unknown, and an
   * item with no overlay of theirs are not_found; another member's is never reached.
   */
  get(userId: string, itemId: string): Promise<OverlayRecord>;
  /**
   * overlays.put: creates the caller's overlay (If-None-Match: *) or replaces it whole
   * (If-Match = its version). Anything else is refused: if_match_required without either,
   * version_conflict when the overlay is not as the header says. A viewer keeps none
   * (forbidden), an item the caller cannot see is not_found, an archived trip trip_archived.
   */
  put(
    ctx: RequestContext,
    itemId: string,
    body: unknown,
    precondition: OverlayPrecondition,
  ): Promise<OverlayRecord>;
}

const overlaysPut = writeOperation('overlays.put', OverlayInput);

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

/** The overlay aggregate's snapshot: its content with whose and where, as restore would copy it. */
function overlaySnapshot(row: OverlayRow) {
  return {
    itemId: row.item_id,
    tripId: row.trip_id,
    membershipId: row.membership_id,
    note: row.note,
    reminderAt: row.reminder_at?.toISOString() ?? null,
    checklist: row.checklist,
  };
}

/** The caller on an item they can see, with their membership; an item they cannot see is not_found. */
async function actingOnItem(
  tx: Tx,
  ctx: RequestContext,
  itemId: string,
  allowed: (role: Parameters<typeof canPutOverlay>[0]) => boolean,
) {
  const userId = actingUser(ctx);
  // The item first: one the caller cannot see does not exist for them, whatever their role.
  const { row, viewer } = await visibleItem(tx, userId, itemId);
  if (!allowed(viewer.role)) throw new ApiError('forbidden');
  return { userId, tripId: row.trip_id, membership: viewer };
}

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createOverlaysService(db: Kysely<DB>, write: WritePath): OverlaysService {
  return {
    async get(userId, itemId) {
      const { viewer } = await visibleItem(db, userId, itemId);
      if (!canGetOverlay(viewer.role)) throw new ApiError('forbidden');
      const row = await findOverlay(forModule(db, 'items'), itemId, viewer.id);
      if (!row) throw new ApiError('not_found');
      return overlayRecord(row);
    },

    put(ctx, itemId, body, precondition) {
      return write(ctx, {
        operation: overlaysPut,
        target: { itemId },
        body,
        ifMatch: precondition.ifMatch,
        authorize: (tx, c, target) => actingOnItem(tx, c, target.itemId, canPutOverlay),
        load: async (tx, target, _input, { tripId, membership }) => {
          const row = await lockOverlay(forModule(tx, 'items'), target.itemId, membership.id);
          if (!row) {
            // Nothing to replace: only a create under If-None-Match: * may follow.
            if (precondition.ifMatch !== undefined) throw new ApiError('version_conflict');
            if (!precondition.createOnly) throw new ApiError('if_match_required');
            return { tripId, row: undefined };
          }
          // An overlay exists, so a create is stale; a replace is compared by the write path.
          if (precondition.createOnly) throw new ApiError('version_conflict');
          return { tripId, counter: row.version, row };
        },
        mutate: async (tx, _c, loaded, input, { tripId, membership }) => {
          const items = forModule(tx, 'items');
          const content = {
            note: input.note ?? null,
            reminderAt:
              input.reminderAt === undefined || input.reminderAt === null
                ? null
                : new Date(input.reminderAt),
            checklist: input.checklist ?? [],
          };
          const row = loaded.row
            ? await replaceOverlay(items, loaded.row.id, content)
            : await insertOverlay(items, {
                ...content,
                tripId,
                itemId,
                membershipId: membership.id,
              }).catch((error: unknown) =>
                // A concurrent create under the same If-None-Match: * lost the race.
                onConstraint(error, {
                  overlays_item_member_key: () => new ApiError('version_conflict'),
                }),
              );
          return {
            action: loaded.row ? 'update' : 'create',
            aggregate: 'overlay',
            entityId: row.id,
            tripId,
            version: row.version,
            snapshot: overlaySnapshot(row),
            result: overlayRecord(row),
          };
        },
      });
    },
  };
}
