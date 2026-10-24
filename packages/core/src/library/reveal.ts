// library.people.reveal: the one way a person's sealed emergency contact leaves the database
// (Technical design, "Reveal"). Who may is the person themself and the owners and organizers
// of a live trip they share; the trips module answers which roles those are, through a port,
// since trips already depends on the library.
import { PersonRevealInput, type PersonReveal } from '@tribo/contract';
import type { Keyring } from '@tribo/crypto';
import { forModule, type DB, type TripRole } from '@tribo/db';
import { actingUser, ApiError, validate, type RequestContext } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordReveal } from '../audit/service.js';
import { inTransaction } from '../transaction.js';
import { canRevealPerson } from './policy.js';
import { findVisiblePerson } from './repo.js';
import { openedContact } from './sealed.js';

/** The roles an account holds in the live trips it shares with a person (trips' sharedTripRoles). */
export type SharedTripRoles = (
  db: Kysely<DB>,
  userId: string,
  personId: string,
) => Promise<TripRole[]>;

export interface PersonRevealService {
  /**
   * library.people.reveal: the plaintext emergency contact, with a reveal audit event on the
   * platform chain naming the field path, never the value. Anyone but the person and the
   * owners and organizers of a live trip they share gets not_found, as for an unknown
   * person, at the same cost.
   */
  reveal(ctx: RequestContext, personId: string, body: unknown): Promise<PersonReveal>;
}

/** Stands in for a person that does not exist, so the trips lookup still runs. */
const NO_ROW = '00000000-0000-0000-0000-000000000000';

export function createPersonRevealService(
  db: Kysely<DB>,
  keys: Keyring,
  sharedTripRoles: SharedTripRoles,
): PersonRevealService {
  return {
    // Not the write path: a reveal changes nothing and has no counter. It runs in one
    // transaction so the event and the answer go together.
    reveal: (ctx, personId, body) =>
      inTransaction(db, async (tx) => {
        const userId = actingUser(ctx);
        // A merged placeholder's id resolves to the survivor, as library.people.get does.
        const row = await findVisiblePerson(forModule(tx, 'library'), userId, personId);
        const sharedRoles = await sharedTripRoles(tx, userId, row?.id ?? NO_ROW);
        if (!row || !canRevealPerson({ self: row.user_id === userId, sharedRoles })) {
          throw new ApiError('not_found');
        }
        const { fields } = validate(PersonRevealInput, body);
        await recordReveal(tx, ctx, {
          entityType: 'person',
          entityId: row.id,
          tripId: null,
          fields,
        });
        const sealed = row.emergency_contact_enc;
        return { emergencyContact: sealed === null ? null : openedContact(keys, row.id, sealed) };
      }),
  };
}
