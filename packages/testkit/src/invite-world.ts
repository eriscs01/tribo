// The trip the invite and member-removal stories test against: one member of each role,
// an outsider, and a placeholder traveller. Each call builds a fresh trip, so tests never
// share rows.
import {
  createInvitesService,
  createMembersService,
  memberItems,
  writePath,
  type MembersService,
} from '@tribo/core';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import type { TestDatabase } from './database.js';
import { testKeys } from './keys.js';
import {
  addMember,
  createPlaceholder,
  createTrip,
  createUser,
  type TripRole,
  type UserFixture,
} from './factories.js';

export type Member = UserFixture & { membershipId: string };

/** Links name this deployment; the token goes in the fragment. */
const PUBLIC_URL = new URL('https://tribo.test');

/** The invites service as runtime.ts composes it, items' side included. */
export function invitesService(tdb: TestDatabase | { db: Kysely<DB> }) {
  return createInvitesService(tdb.db, PUBLIC_URL, memberItems);
}

/** The members service as runtime.ts composes it, items side included. */
export function membersService(db: Kysely<DB>): MembersService {
  return createMembersService(db, writePath(db), testKeys(), memberItems);
}

/** In a day: an expiry every create accepts. */
export const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

export async function inviteWorld(tdb: TestDatabase) {
  const owner = await createUser(tdb.db, { mfa: true });
  const trip = await createTrip(tdb.db, { owner, name: 'Sagada long weekend' });
  const { tripId } = trip;
  const member = async (role: TripRole): Promise<Member> => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  const guestId = await createPlaceholder(tdb.db, {
    createdBy: owner.userId,
    displayName: 'Lola Pacing',
  });
  return {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
    guest: {
      personId: guestId,
      membershipId: await addMember(tdb.db, { tripId, personId: guestId, role: 'viewer' }),
    },
  };
}

/** The stored invite row, hash included. */
export function storedInvite(tdb: TestDatabase, inviteId: string) {
  return tdb.db
    .selectFrom('tribo.invites')
    .selectAll()
    .where('id', '=', inviteId)
    .executeTakeFirstOrThrow();
}
