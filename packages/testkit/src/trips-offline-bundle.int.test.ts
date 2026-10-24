// @module-tag drop-b
// trips.offlineBundle (Drop B): Read bundle for IndexedDB; Sensitive fields always masked; no revealed values; ETag = SHA-256 of the serialized per-caller bundle (R12)
// Through the itinerary module's bundle and the real trips, items, expenses, documents and
// library services: everything the caller may see in the trip, masked as each module's own
// read masks it, the caller's own tickets and overlays and nobody else's, and no sealed value
// in any form.
import { ownOverlays, ownTickets } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, refusal } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createItem,
  createOverlay,
  createTicket,
  createUser,
  softDelete,
} from './factories.js';
import {
  offlineBundleService,
  offlineBundleWorld,
  SEALED_MARKERS,
  type OfflineBundleWorld,
} from './offline-bundle-world.js';
import { counted } from './overlays-world.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();
const sorted = (values: readonly string[]) => [...values].sort();

describe('trips.offlineBundle', () => {
  let w: OfflineBundleWorld;
  beforeAll(async () => {
    w = await offlineBundleWorld(tdb);
  });

  it('lets owner, organizer, member, viewer', async () => {
    for (const caller of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const bundle = await w.bundle.get(caller.userId, w.tripId);
      expect([bundle.trip.id, bundle.membershipId]).toEqual([w.tripId, caller.membershipId]);
    }
  });

  it('answers not_found to an account outside the trip, a removed member and an unknown trip', async () => {
    const removed = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: removed.personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', membershipId);
    expect(await refusal(w.bundle.get(w.outsider.userId, w.tripId))).toBe('not_found');
    expect(await refusal(w.bundle.get(removed.userId, w.tripId))).toBe('not_found');
    expect(
      await refusal(w.bundle.get(w.member.userId, '00000000-0000-7000-8000-000000000001')),
    ).toBe('not_found');
  });

  it('answers not_found once the trip is deleted', async () => {
    const d = await offlineBundleWorld(tdb);
    await softDelete(tdb.db, 'tribo.trips', d.tripId);
    expect(await refusal(d.bundle.get(d.owner.userId, d.tripId))).toBe('not_found');
  });

  it('runs the same queries for a trip the caller is not in as for one that does not exist', async () => {
    const count = async (tripId: string) => {
      const { handle, state } = counted(tdb.db);
      await refusal(offlineBundleService(handle).get(w.outsider.userId, tripId));
      return state.queries;
    };
    expect(await count(w.tripId)).toBe(await count('00000000-0000-7000-8000-000000000001'));
  });

  it('carries the items the caller sees, and nothing of the private flight', async () => {
    const mine = await w.bundle.get(w.member.userId, w.tripId);
    expect(ids(mine.items)).toEqual(sorted([w.lodging, w.rental, w.ferry, w.bus]));
    const others = await w.bundle.get(w.other.userId, w.tripId);
    expect(ids(others.items)).toEqual(sorted([w.lodging, w.rental, w.ferry, w.bus, w.flight]));
    expect(JSON.stringify(mine)).not.toContain(w.flight);
  });

  it('masks the booking ref on the item, as items.list does', async () => {
    const { items } = await w.bundle.get(w.owner.userId, w.tripId);
    expect(items.find((i) => i.id === w.ferry)?.bookingRef).toBe('masked');
  });

  it('carries the rooms and e-bikes with every visible item’s board', async () => {
    const { units, boards } = await w.bundle.get(w.viewer.userId, w.tripId);
    expect(ids(units)).toEqual(sorted([w.room1, w.room2, w.bike]));
    expect(boards.map((b) => b.itemId)).toEqual(sorted([w.lodging, w.rental, w.ferry, w.bus]));
    expect(boards.find((b) => b.itemId === w.lodging)?.allocations).toEqual([
      { membershipId: w.member.membershipId, role: 'occupant', unitId: w.room1, rsvp: null },
    ]);
    expect(boards.find((b) => b.itemId === w.rental)?.allocations).toMatchObject([
      { membershipId: w.member.membershipId, role: 'driver', unitId: w.bike },
    ]);
  });

  it('lays out the group and the caller’s own itinerary', async () => {
    const { itinerary } = await w.bundle.get(w.member.userId, w.tripId);
    const named = (days: { entries: { itemId: string }[] }[]) =>
      [...new Set(days.flatMap((d) => d.entries.map((e) => e.itemId)))].sort();
    expect(named(itinerary.group.days)).toEqual(sorted([w.lodging, w.rental, w.ferry, w.bus]));
    // The member owns the bus and is on the board of the guest house and the rental.
    expect(named(itinerary.me.days)).toEqual(sorted([w.lodging, w.rental, w.bus]));
  });

  it('carries only the caller’s own tickets, on items they see, numbers masked', async () => {
    const { seeded } = w;
    expect(ids((await w.bundle.get(w.member.userId, w.tripId)).tickets)).toEqual(
      sorted([seeded.tickets.memberFerry, seeded.tickets.memberBus]),
    );
    expect(ids((await w.bundle.get(w.owner.userId, w.tripId)).tickets)).toEqual([
      seeded.tickets.ownerFerry,
    ]);
    expect(ids((await w.bundle.get(w.viewer.userId, w.tripId)).tickets)).toEqual([
      seeded.tickets.viewerFerry,
    ]);
    const { tickets } = await w.bundle.get(w.other.userId, w.tripId);
    expect(tickets).toMatchObject([{ id: seeded.tickets.otherFlight, ticketNo: 'masked' }]);
  });

  it('carries only the caller’s own overlays on items they see, and none for a viewer', async () => {
    const { seeded } = w;
    const member = await w.bundle.get(w.member.userId, w.tripId);
    expect(member.overlays).toMatchObject([
      { itemId: w.ferry, note: `bundle-note:${w.member.membershipId}:${w.ferry}` },
    ]);
    const other = await w.bundle.get(w.other.userId, w.tripId);
    expect(other.overlays.map((o) => o.itemId)).toEqual(sorted([w.ferry, w.flight]));
    expect((await w.bundle.get(w.viewer.userId, w.tripId)).overlays).toEqual([]);
    expect((await w.bundle.get(w.owner.userId, w.tripId)).overlays).toEqual([]);
    expect(JSON.stringify(member)).not.toContain(`bundle-note:${w.other.membershipId}`);
    expect(seeded.overlays.viewerFerry).toBeTruthy();
  });

  it('carries the whole ledger, the hidden item’s link nulled and amounts masked for a viewer', async () => {
    const { seeded } = w;
    const member = await w.bundle.get(w.member.userId, w.tripId);
    expect(ids(member.expenses)).toEqual(sorted([seeded.expenses.ferry, seeded.expenses.flight]));
    expect(member.expenses.find((e) => e.id === seeded.expenses.flight)?.itemId).toBeNull();
    expect(member.expenses.find((e) => e.id === seeded.expenses.ferry)?.itemId).toBe(w.ferry);
    const viewer = await w.bundle.get(w.viewer.userId, w.tripId);
    expect(viewer.expenses.map((e) => e.amount)).toEqual([{ masked: true }, { masked: true }]);
  });

  it('carries the file metadata the caller sees, a purged file as purged', async () => {
    const { seeded } = w;
    const member = await w.bundle.get(w.member.userId, w.tripId);
    expect(ids(member.files)).toEqual(sorted([seeded.files.shared, seeded.files.purged]));
    expect(member.files.find((f) => f.id === seeded.files.purged)).toMatchObject({
      filename: 'purged',
      sensitive: true,
    });
    const other = await w.bundle.get(w.other.userId, w.tripId);
    expect(ids(other.files)).toEqual(
      sorted([
        seeded.files.shared,
        seeded.files.othersPrivate,
        seeded.files.onFlight,
        seeded.files.purged,
      ]),
    );
  });

  it('carries the trip’s active members with their contacts, emergency contacts masked', async () => {
    const { members } = await w.bundle.get(w.member.userId, w.tripId);
    expect(ids(members)).toEqual(
      sorted([
        w.owner.membershipId,
        w.organizer.membershipId,
        w.member.membershipId,
        w.other.membershipId,
        w.viewer.membershipId,
      ]),
    );
    expect(members.find((m) => m.id === w.other.membershipId)?.person.hasEmergencyContact).toBe(
      true,
    );
  });

  it('holds no sealed value, for any role', async () => {
    for (const caller of [w.owner, w.organizer, w.member, w.other, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const text = JSON.stringify(await w.bundle.get(caller.userId, w.tripId));
      for (const marker of SEALED_MARKERS) expect(text).not.toContain(marker);
    }
  });

  it('reads the same twice, row for row and key for key', async () => {
    const first = JSON.stringify(await w.bundle.get(w.member.userId, w.tripId));
    expect(JSON.stringify(await w.bundle.get(w.member.userId, w.tripId))).toBe(first);
  });

  it('drops what is removed: a deleted item and its children, a voided expense, a deleted file', async () => {
    const d = await offlineBundleWorld(tdb);
    const before = await d.bundle.get(d.member.userId, d.tripId);
    expect(ids(before.tickets)).toContain(d.seeded.tickets.memberFerry);
    await softDelete(tdb.db, 'tribo.items', d.ferry);
    await softDelete(tdb.db, 'tribo.expenses', d.seeded.expenses.ferry);
    await softDelete(tdb.db, 'tribo.files', d.seeded.files.shared);
    const after = await d.bundle.get(d.member.userId, d.tripId);
    expect(ids(after.items)).not.toContain(d.ferry);
    expect(ids(after.tickets)).toEqual([d.seeded.tickets.memberBus]);
    expect(after.overlays).toEqual([]);
    expect(after.boards.map((b) => b.itemId)).not.toContain(d.ferry);
    expect(ids(after.expenses)).toEqual([d.seeded.expenses.flight]);
    expect(ids(after.files)).toEqual([d.seeded.files.purged]);
  });

  it('still reads an archived trip', async () => {
    const d = await offlineBundleWorld(tdb);
    await archive(tdb, d.tripId);
    expect((await d.bundle.get(d.member.userId, d.tripId)).trip.status).toBe('archived');
  });

  it('keeps each collection within its ceiling and says when one was cut', async () => {
    const small = offlineBundleService(tdb.db, { maxRows: 2 });
    const cut = await small.get(w.other.userId, w.tripId);
    expect(cut.truncated).toBe(true);
    expect(ids(cut.items)).toEqual(sorted([w.lodging, w.rental]));
    expect(cut.members).toHaveLength(2);
    // Children of the items left out stay out with them.
    expect(cut.boards.map((b) => b.itemId)).toEqual(sorted([w.lodging, w.rental]));
    expect(cut.tickets).toEqual([]);
    expect(cut.overlays).toEqual([]);
    expect((await w.bundle.get(w.other.userId, w.tripId)).truncated).toBe(false);
  });

  it('runs the same number of queries however much the trip holds', async () => {
    const count = async (tripId: string, userId: string) => {
      const { handle, state } = counted(tdb.db);
      await offlineBundleService(handle).get(userId, tripId);
      return state.queries;
    };
    const full = await count(w.tripId, w.member.userId);
    const bare = await offlineBundleWorld(tdb);
    await createItem(tdb.db, {
      tripId: bare.tripId,
      ownerMembershipId: bare.member.membershipId,
      title: 'One more stop',
    });
    expect(await count(bare.tripId, bare.member.userId)).toBe(full);
  });

  it('reads the caller’s own tickets and overlays only on items they see, whoever asks the items module', async () => {
    const d = await offlineBundleWorld(tdb);
    // Left on the private flight from before it was made private.
    await createOverlay(tdb.db, {
      tripId: d.tripId,
      itemId: d.flight,
      membershipId: d.member.membershipId,
      note: 'stale',
    });
    await createTicket(tdb.db, d.keys, {
      tripId: d.tripId,
      itemId: d.flight,
      membershipId: d.member.membershipId,
    });
    const viewer = { id: d.member.membershipId, role: 'member' as const, canViewCosts: true };
    const overlays = await ownOverlays(tdb.db, d.member.userId, viewer, d.tripId, 10);
    expect(overlays.map((o) => o.itemId)).toEqual([d.ferry]);
    const tickets = await ownTickets(tdb.db, d.member.userId, viewer, d.tripId, 10);
    expect(ids(tickets)).toEqual(
      sorted([d.seeded.tickets.memberFerry, d.seeded.tickets.memberBus]),
    );
  });
});
