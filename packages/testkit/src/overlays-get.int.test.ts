// @module-tag drop-b
// overlays.get (Drop B): Caller's private note, reminder, checklist; Always private to caller
// Through the overlays service and the real trips and items modules: the caller's own overlay
// on an item they see, never another member's, and one answer for an item that is hidden,
// deleted or unknown.
import type { OverlaysService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { createOverlay, softDelete } from './factories.js';
import { overlaysService, overlaysWorld, type OverlaysWorld } from './overlays-world.js';

let tdb: TestDatabase;
let overlays: OverlaysService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  overlays = overlaysService(tdb.db);
});
afterAll(async () => {
  await tdb.destroy();
});

const REMINDER = new Date('2026-11-10T01:00:00Z');

/** The member's overlay on the guest house. */
function memberOverlay(w: OverlaysWorld, init: { deleted?: boolean } = {}) {
  return createOverlay(tdb.db, {
    tripId: w.tripId,
    itemId: w.lodging,
    membershipId: w.member.membershipId,
    note: 'Ask for the room by the garden',
    reminderAt: REMINDER,
    checklist: [
      { text: 'Print the booking', done: true },
      { text: 'Bring a padlock', done: false },
    ],
    ...init,
  });
}

describe('overlays.get', () => {
  it('answers the caller their own note, reminder and checklist', async () => {
    const w = await overlaysWorld(tdb);
    await memberOverlay(w);
    expect(await overlays.get(w.member.userId, w.lodging)).toEqual({
      itemId: w.lodging,
      tripId: w.tripId,
      note: 'Ask for the room by the garden',
      reminderAt: REMINDER,
      checklist: [
        { text: 'Print the booking', done: true },
        { text: 'Bring a padlock', done: false },
      ],
      version: 1,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
  });

  it('lets the owner, an organizer and a member read their own, and refuses a viewer', async () => {
    const w = await overlaysWorld(tdb);
    for (const who of [w.owner, w.organizer, w.other]) {
      // eslint-disable-next-line no-await-in-loop -- one setup and read at a time
      await createOverlay(tdb.db, {
        tripId: w.tripId,
        itemId: w.lodging,
        membershipId: who.membershipId,
        note: `Note of ${who.membershipId}`,
      });
      // eslint-disable-next-line no-await-in-loop -- as above
      expect((await overlays.get(who.userId, w.lodging)).note).toBe(`Note of ${who.membershipId}`);
    }
    await createOverlay(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.viewer.membershipId,
      note: 'From before they were demoted',
    });
    expect(await refusal(overlays.get(w.viewer.userId, w.lodging))).toBe('forbidden');
  });

  it("never answers another member's overlay: the caller with none gets not_found", async () => {
    const w = await overlaysWorld(tdb);
    await memberOverlay(w);
    expect(await refusal(overlays.get(w.other.userId, w.lodging))).toBe('not_found');
    expect(await refusal(overlays.get(w.owner.userId, w.lodging))).toBe('not_found');
    expect(await refusal(overlays.get(w.organizer.userId, w.lodging))).toBe('not_found');
  });

  it('answers not_found once the overlay is removed', async () => {
    const w = await overlaysWorld(tdb);
    await memberOverlay(w, { deleted: true });
    expect(await refusal(overlays.get(w.member.userId, w.lodging))).toBe('not_found');
  });

  it('answers not_found for an item the caller cannot see, as for an unknown one', async () => {
    const w = await overlaysWorld(tdb);
    await createOverlay(tdb.db, {
      tripId: w.tripId,
      itemId: w.hidden,
      membershipId: w.owner.membershipId,
      note: 'Left from when it was shared',
    });
    expect(await refusal(overlays.get(w.owner.userId, w.hidden))).toBe('not_found');
    expect(await refusal(overlays.get(w.viewer.userId, w.hidden))).toBe('not_found');
    expect(
      await refusal(overlays.get(w.owner.userId, '0192f000-0000-7000-8000-00000000000a')),
    ).toBe('not_found');
  });

  it('answers not_found outside the trip, to a removed member, on a deleted item and a deleted trip', async () => {
    const w = await overlaysWorld(tdb);
    await memberOverlay(w);
    expect(await refusal(overlays.get(w.outsider.userId, w.lodging))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(overlays.get(w.member.userId, w.lodging))).toBe('not_found');

    const v = await overlaysWorld(tdb);
    await memberOverlay(v);
    await softDelete(tdb.db, 'tribo.memberships', v.member.membershipId);
    expect(await refusal(overlays.get(v.member.userId, v.lodging))).toBe('not_found');

    const t = await overlaysWorld(tdb);
    await memberOverlay(t);
    await softDelete(tdb.db, 'tribo.trips', t.tripId);
    expect(await refusal(overlays.get(t.member.userId, t.lodging))).toBe('not_found');
  });
});
