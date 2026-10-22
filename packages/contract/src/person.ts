// Person schemas: library people (an account's own person and placeholder travellers).
import * as z from 'zod';
import { Contacts, ContactsPatch } from './contacts.js';
import { ID_PREFIX, typeId } from './ids.js';
import { MaskedValue } from './masked.js';
import { Instant } from './time.js';

/** How a person is named in trips and the library. */
export const DisplayName = z.string().trim().min(1).max(120);
const Dietary = z.string().trim().min(1).max(500);

/** Who to call if something happens; stored encrypted (emergency_contact_enc, R5). */
export const EmergencyContact = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    relation: z.string().trim().min(1).max(60).optional(),
    phone: z.string().trim().min(3).max(40),
  })
  .meta({ id: 'EmergencyContact' });

export type EmergencyContact = z.infer<typeof EmergencyContact>;

/** library.people.create: a placeholder traveller, owned by the caller who creates it. */
export const PersonInput = z
  .strictObject({
    displayName: DisplayName,
    contacts: Contacts.optional(),
    dietary: Dietary.optional(),
    drivingLicence: z.boolean().optional(),
    emergencyContact: EmergencyContact.optional(),
  })
  .meta({ id: 'PersonInput' });

export type PersonInput = z.infer<typeof PersonInput>;

/** A person as the caller may see it (tribo.person_visible); the emergency contact is masked. */
export const Person = z
  .strictObject({
    id: typeId(ID_PREFIX.person),
    displayName: z.string(),
    /** False for a placeholder traveller, which never gains an account (R28). */
    hasAccount: z.boolean(),
    contacts: Contacts,
    dietary: z.string().nullable(),
    drivingLicence: z.boolean(),
    /** Masked when set; null when there is none. */
    emergencyContact: MaskedValue.nullable(),
    version: z.int().min(1),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Person' });

export type Person = z.infer<typeof Person>;

/**
 * JSON Merge Patch of a person (library.people.update for placeholders, me.update for the
 * caller's own): absent keys stay, null clears. The emergency contact is replaced whole;
 * sending back its masked value is refused with masked_field_write.
 */
export const PersonPatch = z
  .strictObject({
    displayName: DisplayName.optional(),
    contacts: ContactsPatch.optional(),
    dietary: Dietary.nullable().optional(),
    drivingLicence: z.boolean().optional(),
    emergencyContact: z.union([EmergencyContact, MaskedValue]).nullable().optional(),
  })
  .meta({ id: 'PersonPatch' });

export type PersonPatch = z.infer<typeof PersonPatch>;
