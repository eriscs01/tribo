import type { ErrorCode } from '@tribo/contract';
import type { TripRole } from '@tribo/db';
import { organizers } from '../roles.js';

/** A person as the edit rules see it. */
export interface EditablePerson {
  userId: string | null;
  createdBy: string | null;
  erased: boolean;
}

/**
 * library.people.update: placeholders only, by their creator. An account's own person is
 * edited through me.update; an erased person stays a tombstone.
 */
export function placeholderEditRefusal(person: EditablePerson, callerId: string): ErrorCode | null {
  if (person.userId !== null) return 'person_has_account';
  if (person.createdBy !== callerId || person.erased) return 'forbidden';
  return null;
}

/** me.update: an account edits its own person, unless erasure has made it a tombstone. */
export function ownEditRefusal(person: EditablePerson): ErrorCode | null {
  return person.erased ? 'forbidden' : null;
}

/**
 * library.people.reveal: the person themself, or the owner or an organizer of a live trip
 * they share (the registry); anyone else, the placeholder's creator and a plain member or
 * viewer of a shared trip included, is told the person does not exist (decision 0028).
 */
export function canRevealPerson(reveal: {
  self: boolean;
  sharedRoles: readonly TripRole[];
}): boolean {
  return reveal.self || reveal.sharedRoles.some(organizers);
}
