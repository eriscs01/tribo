// @module-tag drop-a
// units.delete (Drop A): Remove unit and its allocations; Deletes its allocations explicitly (units are soft-deleted, nothing cascades); bumps boardVersion; trip_archived on archived trips (R29)
import type { UnitsService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, boardWorld, contexts, history, refusal, unitsService } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, createUnit, softDelete } from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;
const as = contexts('units-delete');

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = unitsService(tdb);
});
afterAll(() => tdb.destroy());

const unitRow = (unitId: string) =>
  tdb.db
    .selectFrom('tribo.units')
    .select(['version', 'deleted_at', 'deleted_by'])
    .where('id', '=', unitId)
    .executeTakeFirstOrThrow();

const boardOf = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.allocations')
    .select(['membership_id', 'role', 'unit_id'])
    .where('item_id', '=', itemId)
    .orderBy('membership_id')
    .orderBy('role')
    .execute();

const boardVersion = async (itemId: string) =>
  (
    await tdb.db
      .selectFrom('tribo.items')
      .select('board_version')
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow()
  ).board_version;

/** Room 1 holds the member and the other member; the organizer attends; the viewer is in room 2. */
async function occupied() {
  const w = await boardWorld(tdb);
  const add = (membershipId: string, role: 'occupant' | 'attendee', unitId?: string) =>
    addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId,
      role,
      ...(unitId ? { unitId } : { rsvp: 'yes' as const }),
    });
  await add(w.member.membershipId, 'occupant', w.room1);
  await add(w.other.membershipId, 'occupant', w.room1);
  await add(w.viewer.membershipId, 'occupant', w.room2);
  await add(w.organizer.membershipId, 'attendee');
  return w;
}

describe('units.delete', () => {
  it("soft-deletes the unit, deletes its allocations and bumps the item's boardVersion", async () => {
    const w = await occupied();
    await units.delete(as(w.owner), w.room1, undefined, 1);
    expect(await unitRow(w.room1)).toEqual({
      version: 2,
      deleted_at: expect.any(Date) as Date,
      deleted_by: w.owner.userId,
    });
    const rest = [
      { membership_id: w.organizer.membershipId, role: 'attendee', unit_id: null },
      { membership_id: w.viewer.membershipId, role: 'occupant', unit_id: w.room2 },
    ].sort((a, b) => a.membership_id.localeCompare(b.membership_id));
    expect(await boardOf(w.lodging)).toEqual(rest);
    expect(await boardVersion(w.lodging)).toBe(2);
    // Gone from reads; its label is free again.
    const page = await units.list(w.owner.userId, w.lodging, { limit: 50 });
    expect(page.items.map((u) => u.id)).toEqual([w.room2]);
  });

  it('lets the item owner, organizers and the owner delete; refuses other members and viewers', async () => {
    const w = await boardWorld(tdb);
    const ownItem = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'lodging',
    });
    const ownRoom = await createUnit(tdb.db, { itemId: ownItem });
    await expect(units.delete(as(w.member), ownRoom, undefined, 1)).resolves.toBeUndefined();
    await expect(units.delete(as(w.organizer), w.room2, undefined, 1)).resolves.toBeUndefined();
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      role: 'assignee',
    });
    expect(await refusal(units.delete(as(w.member), w.room1, undefined, 1))).toBe('forbidden');
    expect(await refusal(units.delete(as(w.viewer), w.room1, undefined, 1))).toBe('forbidden');
    expect((await unitRow(w.room1)).deleted_at).toBeNull();
  });

  it('answers not_found outside the trip, for a hidden item and for a unit already deleted', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.delete(as(w.outsider), w.room1, undefined, 1))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      type: 'lodging',
      visibility: 'private',
    });
    const secretRoom = await createUnit(tdb.db, { itemId: secret });
    expect(await refusal(units.delete(as(w.organizer), secretRoom, undefined, 1))).toBe(
      'not_found',
    );
    await units.delete(as(w.owner), w.room1, undefined, 1);
    expect(await refusal(units.delete(as(w.owner), w.room1, undefined, 2))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(units.delete(as(w.owner), w.room2, undefined, 1))).toBe('not_found');
  });

  it('refuses a body with validation_failed', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.delete(as(w.owner), w.room1, { reason: 'x' }, 1))).toBe(
      'validation_failed',
    );
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await occupied();
    expect(await refusal(units.delete(as(w.owner), w.room1, undefined, undefined))).toBe(
      'if_match_required',
    );
    expect(await refusal(units.delete(as(w.owner), w.room1, undefined, 7))).toBe(
      'version_conflict',
    );
    expect((await unitRow(w.room1)).deleted_at).toBeNull();
    expect(await boardOf(w.lodging)).toHaveLength(4);
    expect(await boardVersion(w.lodging)).toBe(1);
  });

  it('records the unit delete and the item_board update, each with its snapshot, in the one transaction', async () => {
    const w = await occupied();
    const ctx = as(w.owner);
    await units.delete(ctx, w.room1, undefined, 1);
    const unitHistory = await history(tdb, w.room1);
    expect(unitHistory.events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'delete',
        entity_type: 'unit',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      },
    ]);
    // The unit as it was: a restore copies this snapshot forward.
    expect(unitHistory.snapshots).toEqual([
      {
        entity_type: 'unit',
        version: 2,
        snapshot: expect.objectContaining({ label: 'Room 1', capacity: 2 }) as object,
      },
    ]);
    const itemHistory = await history(tdb, w.lodging);
    expect(itemHistory.events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'item_board',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      },
    ]);
    const allocations = [
      { membershipId: w.organizer.membershipId, unitId: null, role: 'attendee', rsvp: 'yes' },
      { membershipId: w.viewer.membershipId, unitId: w.room2, role: 'occupant', rsvp: null },
    ].sort((a, b) => a.membershipId.localeCompare(b.membershipId));
    expect(itemHistory.snapshots).toEqual([
      { entity_type: 'item_board', version: 2, snapshot: { allocations } },
    ]);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await occupied();
    await archive(tdb, w.tripId);
    expect(await refusal(units.delete(as(w.owner), w.room1, undefined, 1))).toBe('trip_archived');
    expect((await unitRow(w.room1)).deleted_at).toBeNull();
    expect(await boardOf(w.lodging)).toHaveLength(4);
  });
});
