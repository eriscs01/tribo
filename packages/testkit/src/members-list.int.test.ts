// @module-tag drop-a
// members.list (Drop A): Members, roles, placeholders; Emergency contact masked; reveal per person
import {
  createLibraryService,
  memberItems,
  createMembersService,
  writePath,
  type MembersService,
} from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createPlaceholder,
  createTrip,
  createUser,
  softDelete,
  type TripRole,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let members: MembersService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  members = createMembersService(tdb.db, writePath(tdb.db), testKeys(), memberItems);
});
afterAll(() => tdb.destroy());

async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

/** A trip with one member of each role, a placeholder traveller and an outsider. */
async function world() {
  const owner = await createUser(tdb.db, { displayName: 'Rosa Owner' });
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole) => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  const organizer = await member('organizer');
  const traveller = await member('member');
  const viewer = await member('viewer');
  const guestId = await createPlaceholder(tdb.db, {
    createdBy: owner.userId,
    displayName: 'Lito (no phone)',
  });
  const guestMembershipId = await addMember(tdb.db, { tripId, personId: guestId, role: 'member' });
  return {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer,
    traveller,
    viewer,
    guest: { personId: guestId, membershipId: guestMembershipId },
    outsider: await createUser(tdb.db),
  };
}

describe('members.list', () => {
  it('lets owner, organizer, member and viewer list every active member, oldest first', async () => {
    const w = await world();
    const expected = [
      w.owner.membershipId,
      w.organizer.membershipId,
      w.traveller.membershipId,
      w.viewer.membershipId,
      w.guest.membershipId,
    ];
    for (const caller of [w.owner, w.organizer, w.traveller, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time reads clearer
      const page = await members.list(caller.userId, w.tripId, { limit: 50 });
      expect(page.items.map((m) => m.id)).toEqual(expected);
      expect(page.nextCursor).toBeNull();
    }
  });

  it('shows each role, the person behind it and placeholders as people without an account', async () => {
    const w = await world();
    const { items } = await members.list(w.viewer.userId, w.tripId, { limit: 50 });
    expect(items[0]).toMatchObject({
      tripId: w.tripId,
      role: 'owner',
      canViewCosts: true,
      version: 1,
      person: { id: w.owner.personId, displayName: 'Rosa Owner', hasAccount: true },
    });
    expect(items.map((m) => m.role)).toEqual(['owner', 'organizer', 'member', 'viewer', 'member']);
    expect(items[4]?.person).toMatchObject({
      id: w.guest.personId,
      displayName: 'Lito (no phone)',
      hasAccount: false,
    });
  });

  it('gives a viewer canViewCosts only with the grant', async () => {
    const w = await world();
    const viewerRow = async () =>
      (await members.list(w.owner.userId, w.tripId, { limit: 50 })).items.find(
        (m) => m.id === w.viewer.membershipId,
      );
    expect(await viewerRow()).toMatchObject({ role: 'viewer', canViewCosts: false });
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ can_view_costs: true })
      .where('id', '=', w.viewer.membershipId)
      .execute();
    expect(await viewerRow()).toMatchObject({ role: 'viewer', canViewCosts: true });
  });

  it('masks the emergency contact: the record says only whether one is stored', async () => {
    const w = await world();
    const library = createLibraryService(tdb.db, writePath(tdb.db), testKeys());
    const ctx: RequestContext = { requestId: 'req-ec', surface: 'web', userId: w.owner.userId };
    const person = await library.createPerson(ctx, {
      displayName: 'Mara',
      emergencyContact: { name: 'Nena', phone: '+63 917 555 0101' },
    });
    await addMember(tdb.db, { tripId: w.tripId, personId: person.id, role: 'member' });
    const { items } = await members.list(w.traveller.userId, w.tripId, { limit: 50 });
    const mara = items.find((m) => m.person.id === person.id);
    expect(mara?.person.hasEmergencyContact).toBe(true);
    expect(items.find((m) => m.person.id === w.guest.personId)?.person.hasEmergencyContact).toBe(
      false,
    );
    expect(JSON.stringify(items)).not.toContain('917 555');
  });

  it('leaves out removed members', async () => {
    const w = await world();
    await softDelete(tdb.db, 'tribo.memberships', w.organizer.membershipId);
    const { items } = await members.list(w.owner.userId, w.tripId, { limit: 50 });
    expect(items.map((m) => m.id)).not.toContain(w.organizer.membershipId);
    expect(items).toHaveLength(4);
  });

  it('pages with an opaque cursor and refuses a forged one', async () => {
    const w = await world();
    const first = await members.list(w.owner.userId, w.tripId, { limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual([w.owner.membershipId, w.organizer.membershipId]);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = await members.list(w.owner.userId, w.tripId, {
      limit: 50,
      cursor: first.nextCursor,
    });
    expect(second.items.map((m) => m.id)).toEqual([
      w.traveller.membershipId,
      w.viewer.membershipId,
      w.guest.membershipId,
    ]);
    expect(second.nextCursor).toBeNull();
    const forged = Buffer.from(JSON.stringify(['not-a-uuid'])).toString('base64url');
    expect(
      await refusal(members.list(w.owner.userId, w.tripId, { limit: 2, cursor: forged })),
    ).toBe('validation_failed');
  });

  it('answers not_found to an account outside the trip, a removed member and on a deleted trip', async () => {
    const w = await world();
    const page = { limit: 50 };
    expect(await refusal(members.list(w.outsider.userId, w.tripId, page))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.traveller.membershipId);
    expect(await refusal(members.list(w.traveller.userId, w.tripId, page))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(members.list(w.owner.userId, w.tripId, page))).toBe('not_found');
  });
});
