// What the people reveal story tests against: the board world's trip (one member of each role
// and an outsider) plus a placeholder traveller in it made by an account outside the trip, and
// an emergency contact sealed for everyone but the second member. Each call builds a fresh
// trip, so tests never share rows.
import { createPersonRevealService, sharedTripRoles, type PersonRevealService } from '@tribo/core';
import type { Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { addMember, createPlaceholder, createUser } from './factories.js';
import { testKeys } from './keys.js';
import { sealEmergencyContact } from './offline-bundle-world.js';

export function personRevealService(db: Kysely<DB>, keys: Keyring): PersonRevealService {
  return createPersonRevealService(db, keys, sharedTripRoles);
}

/** The emergency contact sealed for a person: their id in the name, so each is told apart by value. */
export const contactOf = (personId: string) => ({
  name: `sos-contact:${personId}`,
  phone: '+63 917 555 0100',
});

export async function peopleRevealWorld(tdb: TestDatabase) {
  const w = await boardWorld(tdb);
  const keys = testKeys();
  const creator = await createUser(tdb.db);
  const placeholder = await createPlaceholder(tdb.db, { createdBy: creator.userId });
  await addMember(tdb.db, { tripId: w.tripId, personId: placeholder, role: 'member' });
  for (const personId of [
    w.owner.personId,
    w.organizer.personId,
    w.member.personId,
    w.viewer.personId,
    placeholder,
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one row each
    await sealEmergencyContact(tdb.db, keys, personId, contactOf(personId));
  }
  return {
    ...w,
    keys,
    creator,
    placeholder,
    contactOf,
    reveal: personRevealService(tdb.db, keys),
  };
}

export type PeopleRevealWorld = Awaited<ReturnType<typeof peopleRevealWorld>>;
