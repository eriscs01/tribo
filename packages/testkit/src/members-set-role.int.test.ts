// @module-tag drop-a
// members.setRole (Drop A): Change role or canViewCosts; Owner transfer to an MFA member demotes the old owner to organizer in the same write (G14); MCP approval; trip_archived on archived trips (R29)
import {
  accountHasMfa,
  memberItems,
  createMembersService,
  createTripsService,
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
  type UserFixture,
} from './factories.js';
import { testKeys } from './keys.js';

let tdb: TestDatabase;
let members: MembersService;
let n = 0;
const as = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `req-role-${String(n)}`, surface: 'web', userId: user.userId };
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  members = createMembersService(tdb.db, writePath(tdb.db), testKeys(), accountHasMfa, memberItems);
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

/** A trip with one member of each role (the member has MFA), a placeholder and an outsider. */
async function world() {
  const owner = await createUser(tdb.db, { mfa: true });
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole, init: { mfa?: boolean } = {}) => {
    const user = await createUser(tdb.db, init);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  const guestId = await createPlaceholder(tdb.db, { createdBy: owner.userId });
  return {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member', { mfa: true }),
    viewer: await member('viewer'),
    guest: {
      personId: guestId,
      membershipId: await addMember(tdb.db, { tripId, personId: guestId, role: 'member' }),
    },
    outsider: await createUser(tdb.db, { mfa: true }),
  };
}

const stored = (membershipId: string) =>
  tdb.db
    .selectFrom('tribo.memberships')
    .select(['trip_role', 'can_view_costs', 'version'])
    .where('id', '=', membershipId)
    .executeTakeFirstOrThrow();

describe('members.setRole', () => {
  it("lets the owner change a member's role, bumping its version", async () => {
    const w = await world();
    const changed = await members.setRole(
      as(w.owner),
      w.tripId,
      w.member.membershipId,
      { role: 'organizer' },
      1,
    );
    expect(changed).toMatchObject({ id: w.member.membershipId, role: 'organizer', version: 2 });
    expect(await stored(w.member.membershipId)).toMatchObject({ trip_role: 'organizer' });
    const listed = await members.list(w.viewer.userId, w.tripId, { limit: 50 });
    expect(listed.items.find((m) => m.id === w.member.membershipId)?.role).toBe('organizer');
  });

  it('grants and withdraws a viewer cost grant, and drops it when the viewer moves on', async () => {
    const w = await world();
    const id = w.viewer.membershipId;
    await expect(
      members.setRole(as(w.owner), w.tripId, id, { canViewCosts: true }, 1),
    ).resolves.toMatchObject({ role: 'viewer', canViewCosts: true, version: 2 });
    await members.setRole(as(w.owner), w.tripId, id, { role: 'member' }, 2);
    expect(await stored(id)).toMatchObject({ trip_role: 'member', can_view_costs: false });
    // Back to viewer: the old grant does not come back with it.
    await expect(
      members.setRole(as(w.owner), w.tripId, id, { role: 'viewer' }, 3),
    ).resolves.toMatchObject({ role: 'viewer', canViewCosts: false });
  });

  it('refuses a cost grant for anyone but a viewer with validation_failed, writing nothing', async () => {
    const w = await world();
    const error = await members
      .setRole(as(w.owner), w.tripId, w.member.membershipId, { canViewCosts: true }, 1)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: '/canViewCosts', message: 'only a viewer takes a cost grant' }] },
    });
    expect(
      await refusal(
        members.setRole(
          as(w.owner),
          w.tripId,
          w.viewer.membershipId,
          { role: 'member', canViewCosts: true },
          1,
        ),
      ),
    ).toBe('validation_failed');
    expect(await stored(w.member.membershipId)).toMatchObject({ version: 1 });
    expect(await stored(w.viewer.membershipId)).toMatchObject({ version: 1, trip_role: 'viewer' });
  });

  it('G14: hands the trip to a member with MFA and makes the old owner an organizer, in one write', async () => {
    const w = await world();
    const ctx = as(w.owner);
    const promoted = await members.setRole(
      ctx,
      w.tripId,
      w.member.membershipId,
      { role: 'owner' },
      1,
    );
    expect(promoted).toMatchObject({ role: 'owner', version: 2 });
    expect(await stored(w.owner.membershipId)).toMatchObject({
      trip_role: 'organizer',
      version: 2,
    });
    const events = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['action', 'entity_type', 'entity_id', 'version_before', 'version_after'])
      .where('request_id', '=', ctx.requestId)
      .orderBy('seq')
      .execute();
    expect(events).toEqual([
      {
        action: 'role_change',
        entity_type: 'membership',
        entity_id: w.member.membershipId,
        version_before: 1,
        version_after: 2,
      },
      {
        action: 'role_change',
        entity_type: 'membership',
        entity_id: w.owner.membershipId,
        version_before: 1,
        version_after: 2,
      },
    ]);
    // The new owner now acts as owner, and the old one no longer does.
    expect(
      await refusal(
        members.setRole(as(w.owner), w.tripId, w.viewer.membershipId, { role: 'member' }, 1),
      ),
    ).toBe('forbidden');
    await expect(
      members.setRole(as(w.member), w.tripId, w.viewer.membershipId, { role: 'member' }, 1),
    ).resolves.toMatchObject({ role: 'member' });
    // The trip's owner check (trips.delete) follows the transfer.
    const trips = createTripsService(tdb.db, writePath(tdb.db));
    expect(await refusal(trips.delete(as(w.owner), w.tripId, undefined, 1))).toBe('forbidden');
  });

  it('refuses to hand the trip to a member without MFA or a placeholder with mfa_required', async () => {
    const w = await world();
    for (const target of [w.organizer.membershipId, w.guest.membershipId]) {
      const transfer = members.setRole(as(w.owner), w.tripId, target, { role: 'owner' }, 1);
      // eslint-disable-next-line no-await-in-loop -- one target at a time
      expect(await refusal(transfer)).toBe('mfa_required');
    }
    expect(await stored(w.owner.membershipId)).toMatchObject({ trip_role: 'owner', version: 1 });
  });

  it('refuses the owner stepping down without handing over with owner_transfer_required', async () => {
    const w = await world();
    expect(
      await refusal(
        members.setRole(as(w.owner), w.tripId, w.owner.membershipId, { role: 'organizer' }, 1),
      ),
    ).toBe('owner_transfer_required');
    expect(await stored(w.owner.membershipId)).toMatchObject({ trip_role: 'owner', version: 1 });
  });

  it('refuses organizer, member and viewer with forbidden', async () => {
    const w = await world();
    for (const caller of [w.organizer, w.member, w.viewer]) {
      const change = members.setRole(
        as(caller),
        w.tripId,
        w.guest.membershipId,
        { role: 'viewer' },
        1,
      );
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      expect(await refusal(change)).toBe('forbidden');
    }
    expect(await stored(w.guest.membershipId)).toMatchObject({ trip_role: 'member', version: 1 });
  });

  it('answers not_found outside the trip, for a removed member and for a member of another trip', async () => {
    const w = await world();
    const body = { role: 'viewer' };
    expect(
      await refusal(members.setRole(as(w.outsider), w.tripId, w.member.membershipId, body, 1)),
    ).toBe('not_found');
    const other = await createTrip(tdb.db, { owner: w.outsider });
    expect(
      await refusal(members.setRole(as(w.owner), w.tripId, other.ownerMembershipId, body, 1)),
    ).toBe('not_found');
    await softDelete(tdb.db, 'tribo.memberships', w.member.membershipId);
    expect(
      await refusal(members.setRole(as(w.owner), w.tripId, w.member.membershipId, body, 1)),
    ).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await world();
    for (const body of [{ role: 'admin' }, { canViewCosts: 'yes' }, { nickname: 'Lito' }, null]) {
      const change = members.setRole(as(w.owner), w.tripId, w.viewer.membershipId, body, 1);
      // eslint-disable-next-line no-await-in-loop -- each body is its own write
      expect(await refusal(change)).toBe('validation_failed');
    }
    expect(await stored(w.viewer.membershipId)).toMatchObject({ version: 1 });
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await world();
    const id = w.viewer.membershipId;
    const body = { role: 'member' };
    expect(await refusal(members.setRole(as(w.owner), w.tripId, id, body, undefined))).toBe(
      'if_match_required',
    );
    await members.setRole(as(w.owner), w.tripId, id, { canViewCosts: true }, 1);
    expect(await refusal(members.setRole(as(w.owner), w.tripId, id, body, 1))).toBe(
      'version_conflict',
    );
    expect(await stored(id)).toMatchObject({ trip_role: 'viewer', version: 2 });
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await world();
    await members.setRole(as(w.owner), w.tripId, w.viewer.membershipId, { canViewCosts: true }, 1);
    const event = await tdb.db
      .selectFrom('audit.audit_events')
      .select(['chain_key', 'action', 'entity_type', 'version_before', 'version_after'])
      .where('entity_id', '=', w.viewer.membershipId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      chain_key: `trip:${w.tripId}`,
      action: 'role_change',
      entity_type: 'membership',
      version_before: 1,
      version_after: 2,
    });
    const snapshot = await tdb.db
      .selectFrom('tribo.entity_versions')
      .select(['entity_type', 'trip_id', 'version', 'snapshot'])
      .where('entity_id', '=', w.viewer.membershipId)
      .executeTakeFirstOrThrow();
    expect(snapshot).toEqual({
      entity_type: 'membership',
      trip_id: w.tripId,
      version: 2,
      snapshot: { personId: w.viewer.personId, role: 'viewer', canViewCosts: true },
    });
  });

  it('R29: answers trip_archived on an archived trip, changing nothing', async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', w.tripId)
      .execute();
    expect(
      await refusal(
        members.setRole(as(w.owner), w.tripId, w.member.membershipId, { role: 'owner' }, 1),
      ),
    ).toBe('trip_archived');
    expect(await stored(w.owner.membershipId)).toMatchObject({ trip_role: 'owner' });
    expect(await stored(w.member.membershipId)).toMatchObject({ trip_role: 'member' });
  });
});
