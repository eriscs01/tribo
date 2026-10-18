import type { ErrorCode } from '@tribo/contract';

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
