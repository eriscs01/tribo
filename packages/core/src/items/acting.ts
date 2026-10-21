// What every items-module operation shares, whether it acts on the item itself, its units or
// its board: who the caller is on one item, the item's write lock, how costs mask, and the
// board's snapshot. Private to the module; service.ts and units.ts both build on it.
import { forModule, type DB } from '@tribo/db';
import { Uuid } from '@tribo/contract';
import {
  ApiError,
  decodeCursor,
  invalidCursor,
  type RequestContext,
  type Tx,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { callerMembership, type CallerMembership } from '../trips/service.js';
import { seesRestrictedFields, type ItemEditor } from './policy.js';
import { findVisibleItem, isAssignee, listBoard, lockItem, type ItemRow } from './repo.js';

/** The caller acting on one item they can see: account, membership and standing on it. */
export interface ActingEditor {
  userId: string;
  row: ItemRow;
  membership: CallerMembership;
  editor: ItemEditor;
}

/**
 * Who is acting on an item. An item the caller cannot see (tribo.item_visible) does not
 * exist for them.
 */
export async function actingEditor(
  tx: Tx,
  ctx: RequestContext,
  itemId: string,
): Promise<ActingEditor> {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  const items = forModule(tx, 'items');
  const row = await findVisibleItem(items, ctx.userId, itemId);
  const membership = row ? await callerMembership(tx, ctx.userId, row.trip_id) : null;
  if (!row || !membership) throw new ApiError('not_found');
  const owns = row.owner_membership_id === membership.id;
  const assigned = !owns && (await isAssignee(items, row.id, membership.id));
  return {
    userId: ctx.userId,
    row,
    membership,
    editor: { role: membership.role, owns, assigned },
  };
}

/**
 * A read of one item: the row and the reader's membership, or not_found when
 * tribo.item_visible hides it from them.
 */
export async function visibleItem(
  db: Kysely<DB>,
  userId: string,
  itemId: string,
): Promise<{ row: ItemRow; viewer: CallerMembership }> {
  const row = await findVisibleItem(forModule(db, 'items'), userId, itemId);
  const viewer = row ? await callerMembership(db, userId, row.trip_id) : null;
  if (!row || !viewer) throw new ApiError('not_found');
  return { row, viewer };
}

/** The write path's load for one item: the live row, locked until commit. */
export async function lockedItem(tx: Tx, target: { itemId: string }) {
  const row = await lockItem(forModule(tx, 'items'), target.itemId);
  if (!row) throw new ApiError('not_found');
  return { tripId: row.trip_id, counter: row.version, row };
}

/**
 * The item's money as this reader sees it: its cost, and its units' rates. Masked for a
 * viewer without canViewCosts when there is an amount, and, once the item restricts its
 * cost, for anyone who may not see its restricted fields, amount or not (decision 0003).
 */
export function moneyView<T>(
  row: Pick<ItemRow, 'owner_membership_id' | 'restricted_fields'>,
  viewer: Pick<CallerMembership, 'id' | 'role' | 'canViewCosts'>,
  stored: T | null,
): T | 'masked' | null {
  if (restrictedHidden(row, viewer, 'cost')) return 'masked';
  return stored !== null && !viewer.canViewCosts ? 'masked' : stored;
}

/** Whether one restricted field of the item is masked for this reader (decision 0003). */
export function restrictedHidden(
  row: Pick<ItemRow, 'owner_membership_id' | 'restricted_fields'>,
  viewer: Pick<CallerMembership, 'id' | 'role'>,
  field: string,
): boolean {
  if (!row.restricted_fields.includes(field)) return false;
  return !seesRestrictedFields({ role: viewer.role, owns: row.owner_membership_id === viewer.id });
}

/** The whole assignment board, the item_board aggregate's snapshot (rows have no version). */
export function boardSnapshot(rows: Awaited<ReturnType<typeof listBoard>>) {
  return {
    allocations: rows.map((r) => ({
      membershipId: r.membership_id,
      unitId: r.unit_id,
      role: r.role,
      rsvp: r.rsvp,
    })),
  };
}

export function invalid(path: string, message: string): ApiError {
  return new ApiError('validation_failed', { errors: [{ path, message }] });
}

/** A cursor over rows in id order (items, units); anything else is refused before it reaches SQL. */
export function idCursor(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  const key = Uuid.safeParse(id);
  if (!key.success) throw invalidCursor();
  return key.data;
}
