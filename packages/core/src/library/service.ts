import { PersonInput, type Contacts, type EmergencyContact } from '@tribo/contract';
import { sealJson, type FieldRef, type Keyring } from '@tribo/crypto';
import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  type Change,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { writeOperation } from '../write-operation.js';
import {
  findAccountPerson,
  findPerson,
  findVisiblePerson,
  insertAccountPerson,
  insertPlaceholder,
  newRowId,
  type PersonRow,
} from './repo.js';

/** A person as the library hands it out; sensitive values stay inside the module. */
export interface PersonRecord {
  id: string;
  hasAccount: boolean;
  displayName: string;
  contacts: Contacts;
  dietary: string | null;
  drivingLicence: boolean;
  /** Whether an emergency contact is stored; its value is masked for every reader. */
  hasEmergencyContact: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryService {
  /** library.people.create: a placeholder traveller the caller creates and alone edits. */
  createPerson(ctx: RequestContext, body: unknown): Promise<PersonRecord>;
  /** library.people.get: not_found unless tribo.person_visible lets the caller see it. */
  getPerson(userId: string, personId: string): Promise<PersonRecord>;
}

const peopleCreate = writeOperation('library.people.create', PersonInput);

const EMERGENCY_CONTACT = (personId: string): FieldRef => ({
  table: 'persons',
  column: 'emergency_contact_enc',
  rowId: personId,
});

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createLibraryService(
  db: Kysely<DB>,
  write: WritePath,
  keys: Keyring,
): LibraryService {
  const sealContact = (personId: string, contact: EmergencyContact | null) =>
    contact === null ? null : sealJson(keys, EMERGENCY_CONTACT(personId), contact);

  return {
    async getPerson(userId, personId) {
      const row = await findVisiblePerson(forModule(db, 'library'), userId, personId);
      if (!row) throw new ApiError('not_found');
      return personRecord(row);
    },

    createPerson: (ctx, body) =>
      write(ctx, {
        operation: peopleCreate,
        target: null,
        body,
        ifMatch: undefined,
        authorize: (_tx, c) =>
          c.userId === null ? Promise.reject(new ApiError('unauthenticated')) : Promise.resolve(),
        load: () => Promise.resolve({ tripId: null }),
        mutate: async (tx, c, _loaded, input) => {
          const library = forModule(tx, 'library');
          const id = await newRowId(library);
          await insertPlaceholder(library, {
            id,
            createdBy: actingUser(c),
            displayName: input.displayName,
            contacts: input.contacts ?? {},
            dietary: input.dietary ?? null,
            drivingLicence: input.drivingLicence ?? false,
            emergencyContactEnc: sealContact(id, input.emergencyContact ?? null),
          });
          return personChange(tx, 'create', id);
        },
      }),
  };
}

/** The write's change for a person just written in this transaction: snapshot and result. */
async function personChange(
  tx: Tx,
  action: 'create' | 'update',
  personId: string,
): Promise<Change<PersonRecord>> {
  const row = await findPerson(forModule(tx, 'library'), personId);
  if (!row) throw new Error(`person ${personId} vanished inside its own write`);
  return {
    action,
    aggregate: 'person',
    entityId: row.id,
    tripId: null,
    version: row.version,
    snapshot: personSnapshot(row),
    result: personRecord(row),
  };
}

/** Every stored field; ciphertext stays ciphertext (Audit and versioning). */
function personSnapshot(row: PersonRow) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    contacts: contactsOf(row.contacts),
    dietary: row.dietary,
    drivingLicence: row.driving_licence,
    emergencyContactEnc: row.emergency_contact_enc?.toString('base64') ?? null,
  };
}

/** contacts is written only through the Contacts schema; anything else in the column is dropped. */
function contactsOf(stored: unknown): Contacts {
  const value = (stored ?? {}) as Record<string, unknown>;
  const pick = (key: keyof Contacts) =>
    typeof value[key] === 'string' ? { [key]: value[key] } : {};
  return { ...pick('phone'), ...pick('email'), ...pick('messenger') };
}

function personRecord(row: PersonRow): PersonRecord {
  return {
    id: row.id,
    hasAccount: row.user_id !== null,
    displayName: row.display_name,
    contacts: contactsOf(row.contacts),
    dietary: row.dietary,
    drivingLicence: row.driving_licence,
    hasEmergencyContact: row.emergency_contact_enc !== null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Writes need an account behind them; only system work runs without one. */
function actingUser(ctx: RequestContext): string {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  return ctx.userId;
}

/**
 * Every account has exactly one person, made with the account. Returns the person's
 * create as a change for the caller to record in the same transaction.
 */
export async function createAccountPerson(
  tx: Tx,
  account: { userId: string; displayName: string },
): Promise<Change<{ personId: string }>> {
  const row = await insertAccountPerson(
    forModule(tx, 'library'),
    account.userId,
    account.displayName,
  );
  return {
    action: 'create',
    aggregate: 'person',
    entityId: row.id,
    tripId: null,
    version: row.version,
    snapshot: { userId: row.user_id, displayName: row.display_name },
    result: { personId: row.id },
  };
}

/** The person an account is inside every trip, through its memberships; null if it has none. */
export async function accountPersonId(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await findAccountPerson(forModule(db, 'library'), userId);
  return row?.id ?? null;
}
