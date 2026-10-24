// The emergency contact's envelope (R5): sealed JSON bound to its person's row (AAD), so a
// value copied to another person does not open. Private to the module; the library service
// seals it and the reveal alone opens it.
import type { EmergencyContact } from '@tribo/contract';
import { openJson, sealJson, type FieldRef, type Keyring } from '@tribo/crypto';

const EMERGENCY_CONTACT = (personId: string): FieldRef => ({
  table: 'persons',
  column: 'emergency_contact_enc',
  rowId: personId,
});

/** The emergency contact sealed to its person's row, or null for none. */
export function sealedContact(
  keys: Keyring,
  personId: string,
  contact: EmergencyContact | null,
): Buffer | null {
  return contact === null ? null : sealJson(keys, EMERGENCY_CONTACT(personId), contact);
}

/** The stored emergency contact opened for its person; throws when it does not open there. */
export function openedContact(keys: Keyring, personId: string, sealed: Buffer): EmergencyContact {
  return openJson(keys, EMERGENCY_CONTACT(personId), sealed) as EmergencyContact;
}
