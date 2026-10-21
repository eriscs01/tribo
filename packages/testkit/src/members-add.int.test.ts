// @module-tag drop-a
// members.add (Drop A): Add placeholder traveller (new or visible library person); person_visible on personId; Person must have no account: person_has_account → send an invite (R4); A removed placeholder is undeleted rather than re-added; trip_archived on archived trips (R29)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import {
  createLibraryService,
  accountHasMfa,
  createMembersService,
  writePath,
  type LibraryService,
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
  type UserFixture,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let members: MembersService;
let library: LibraryService;
let n = 0;
const as = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `req-add-${String(n)}`, surface: 'web', userId: user.userId };
};
const per = (id: string) => encodeTypeId(ID_PREFIX.person, id);

beforeAll(async () => {
  tdb = await createTestDatabase();
  const keys = testKeys();
  members = createMembersService(tdb.db, writePath(tdb.db), keys, accountHasMfa);
  library = createLibraryService(tdb.db, writePath(tdb.db), keys);
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

/** A trip with one member of each role and an outsider. */
async function world() {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole) => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  return {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
}

const memberIds = async (tripId: string, caller: UserFixture) =>
  (await members.list(caller.userId, tripId, { limit: 50 })).items.map((m) => m.id);

const personCount = async () =>
  Number(
    (
      await tdb.db
        .selectFrom('tribo.persons')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe('members.add', () => {
  it('lets the owner add a new placeholder, made in the library as theirs', async () => {
    const w = await world();
    const added = await members.add(as(w.owner), w.tripId, {
      person: { displayName: 'Lito', dietary: 'no pork' },
    });
    expect(added).toMatchObject({
      tripId: w.tripId,
      role: 'member',
      canViewCosts: true,
      version: 1,
      person: { displayName: 'Lito', dietary: 'no pork', hasAccount: false },
    });
    expect(await memberIds(w.tripId, w.member)).toContain(added.id);
    // The library owns the person: its creator reads and edits it there.
    await expect(library.getPerson(w.owner.userId, added.person.id)).resolves.toMatchObject({
      displayName: 'Lito',
      hasAccount: false,
    });
    await expect(
      library.updatePerson(as(w.owner), added.person.id, { dietary: null }, 1),
    ).resolves.toMatchObject({ dietary: null });
  });

  it('adds a placeholder from the library that the owner can see, with the role asked for', async () => {
    const w = await world();
    const guest = await library.createPerson(as(w.owner), { displayName: 'Mara' });
    const added = await members.add(as(w.owner), w.tripId, {
      personId: per(guest.id),
      role: 'viewer',
    });
    expect(added).toMatchObject({
      role: 'viewer',
      canViewCosts: false,
      person: { id: guest.id, displayName: 'Mara' },
    });
    // A placeholder from another trip the owner shares is visible too (person_visible).
    const other = await createUser(tdb.db);
    const elsewhere = await createTrip(tdb.db, { owner: other });
    await addMember(tdb.db, {
      tripId: elsewhere.tripId,
      personId: w.owner.personId,
      role: 'member',
    });
    const theirs = await createPlaceholder(tdb.db, { createdBy: other.userId });
    await addMember(tdb.db, { tripId: elsewhere.tripId, personId: theirs, role: 'member' });
    await expect(
      members.add(as(w.owner), w.tripId, { personId: per(theirs) }),
    ).resolves.toMatchObject({ person: { id: theirs } });
  });

  it('refuses organizer, member and viewer with forbidden, adding no one', async () => {
    const w = await world();
    for (const caller of [w.organizer, w.member, w.viewer]) {
      const add = members.add(as(caller), w.tripId, { person: { displayName: 'X' } });
      // eslint-disable-next-line no-await-in-loop -- one caller at a time reads clearer
      expect(await refusal(add)).toBe('forbidden');
    }
    expect(await memberIds(w.tripId, w.owner)).toHaveLength(4);
  });

  it('answers not_found to an account outside the trip and on a deleted trip', async () => {
    const w = await world();
    const body = { person: { displayName: 'Lito' } };
    expect(await refusal(members.add(as(w.outsider), w.tripId, body))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(members.add(as(w.owner), w.tripId, body))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await world();
    const before = await personCount();
    const guest = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    const bodies = [
      {},
      { person: { displayName: '' } },
      { personId: per(guest), person: { displayName: 'Both' } },
      { personId: per(guest), role: 'owner' },
      { personId: 'per_nope' },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each body is its own write
      expect(await refusal(members.add(as(w.owner), w.tripId, body))).toBe('validation_failed');
    }
    expect(await personCount()).toBe(before + 1);
    expect(await memberIds(w.tripId, w.owner)).toHaveLength(4);
  });

  it('refuses a person the owner cannot see as validation_failed, as if it did not exist', async () => {
    const w = await world();
    const stranger = await createUser(tdb.db);
    const hidden = await createPlaceholder(tdb.db, { createdBy: stranger.userId });
    const unknown = per('01900000-0000-7000-8000-000000000000');
    for (const personId of [per(hidden), unknown]) {
      // eslint-disable-next-line no-await-in-loop -- each body is its own write
      const error = await members.add(as(w.owner), w.tripId, { personId }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'validation_failed',
        extra: { errors: [{ path: '/personId', message: 'no such person' }] },
      });
    }
  });

  it('R4: answers person_has_account for a person with an account; they need an invite', async () => {
    const w = await world();
    // A co-member elsewhere is visible to the owner, but has an account.
    const friend = await createUser(tdb.db);
    const elsewhere = await createTrip(tdb.db, { owner: friend });
    await addMember(tdb.db, {
      tripId: elsewhere.tripId,
      personId: w.owner.personId,
      role: 'member',
    });
    expect(
      await refusal(members.add(as(w.owner), w.tripId, { personId: per(friend.personId) })),
    ).toBe('person_has_account');
    expect(
      await refusal(members.add(as(w.owner), w.tripId, { personId: per(w.owner.personId) })),
    ).toBe('person_has_account');
    expect(await memberIds(w.tripId, w.owner)).toHaveLength(4);
  });

  it('answers already_member for a placeholder that is in the trip', async () => {
    const w = await world();
    const added = await members.add(as(w.owner), w.tripId, { person: { displayName: 'Lito' } });
    expect(
      await refusal(members.add(as(w.owner), w.tripId, { personId: per(added.person.id) })),
    ).toBe('already_member');
  });

  it('undeletes a removed placeholder rather than adding it again: same membership, next version', async () => {
    const w = await world();
    const added = await members.add(as(w.owner), w.tripId, { person: { displayName: 'Lito' } });
    await tdb.db
      .updateTable('tribo.memberships')
      .set({ deleted_at: new Date(), version: 2 })
      .where('id', '=', added.id)
      .execute();
    const back = await members.add(as(w.owner), w.tripId, {
      personId: per(added.person.id),
      role: 'organizer',
    });
    expect(back).toMatchObject({ id: added.id, role: 'organizer', version: 3 });
    expect(await memberIds(w.tripId, w.owner)).toContain(added.id);
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['action', 'entity_type', 'version_before', 'version_after'])
      .where('entity_id', '=', added.id)
      .where('version_after', '=', 3)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      action: 'restore',
      entity_type: 'membership',
      version_before: 2,
      version_after: 3,
    });
  });

  it('records the membership and the new person, each with its event and snapshot, in one transaction', async () => {
    const w = await world();
    const ctx = as(w.owner);
    const added = await members.add(ctx, w.tripId, {
      person: {
        displayName: 'Lito',
        emergencyContact: { name: 'Nena', phone: '+63 917 555 0101' },
      },
    });
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'entity_id', 'version_after', 'actor_user_id'])
      .where('request_id', '=', ctx.requestId)
      .orderBy('occurred_at')
      .orderBy('seq')
      .execute();
    expect(events).toEqual(
      expect.arrayContaining([
        {
          chain_key: `trip:${w.tripId}`,
          action: 'create',
          entity_type: 'membership',
          entity_id: added.id,
          version_after: 1,
          actor_user_id: w.owner.userId,
        },
        {
          chain_key: 'platform',
          action: 'create',
          entity_type: 'person',
          entity_id: added.person.id,
          version_after: 1,
          actor_user_id: w.owner.userId,
        },
      ]),
    );
    expect(events).toHaveLength(2);
    const snapshots = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'trip_id', 'snapshot'])
      .where('entity_id', 'in', [added.id, added.person.id])
      .orderBy('entity_type')
      .execute();
    expect(snapshots).toMatchObject([
      {
        entity_type: 'membership',
        trip_id: w.tripId,
        snapshot: { personId: added.person.id, role: 'member', canViewCosts: false },
      },
      { entity_type: 'person', trip_id: null, snapshot: { displayName: 'Lito', userId: null } },
    ]);
    expect(JSON.stringify(snapshots)).not.toContain('917 555');
  });

  it('rolls the new person back when the membership cannot be written', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    const before = await personCount();
    expect(
      await refusal(members.add(as(w.owner), w.tripId, { person: { displayName: 'Lito' } })),
    ).toBe('trip_archived');
    expect(await personCount()).toBe(before);
  });

  it('R29: answers trip_archived on an archived trip, adding no one', async () => {
    const w = await world();
    const guest = await createPlaceholder(tdb.db, { createdBy: w.owner.userId });
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(await refusal(members.add(as(w.owner), w.tripId, { personId: per(guest) }))).toBe(
      'trip_archived',
    );
    expect(await memberIds(w.tripId, w.owner)).toHaveLength(4);
  });

  it('takes no Idempotency-Key in 1a: the same body twice adds two placeholders', async () => {
    const w = await world();
    const body = { person: { displayName: 'Lito' } };
    const first = await members.add(as(w.owner), w.tripId, body);
    const second = await members.add(as(w.owner), w.tripId, body);
    expect(second.id).not.toBe(first.id);
    expect(second.person.id).not.toBe(first.person.id);
  });
});
