import {
  PersonInput,
  PersonPatch,
  PlaceInput,
  type Contacts,
  type EmergencyContact,
  type OpeningHours,
} from '@tribo/contract';
import { sealJson, type FieldRef, type Keyring } from '@tribo/crypto';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  ApiError,
  type Change,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { writeOperation } from '../write-operation.js';
import { placeholderEditRefusal } from './policy.js';
import {
  findAccountPerson,
  findPerson,
  findVisiblePerson,
  insertAccountPerson,
  insertPlace,
  insertPlaceholder,
  lockPerson,
  newRowId,
  updatePerson,
  type PersonFields,
  type PersonRow,
  type PlaceRow,
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

export interface PlaceRecord {
  id: string;
  name: string;
  kind: ValueOf<'tribo.places.kind'>;
  location: { lat: number; lng: number } | null;
  address: string | null;
  hours: OpeningHours | null;
  links: string[];
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryService {
  /** library.people.create: a placeholder traveller the caller creates and alone edits. */
  createPerson(ctx: RequestContext, body: unknown): Promise<PersonRecord>;
  /** library.people.get: not_found unless tribo.person_visible lets the caller see it. */
  getPerson(userId: string, personId: string): Promise<PersonRecord>;
  /** library.people.update: a placeholder, by its creator, under If-Match on its version. */
  updatePerson(
    ctx: RequestContext,
    personId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<PersonRecord>;
  /** library.places.create: any signed-in user adds to the one shared library (G11). */
  createPlace(ctx: RequestContext, body: unknown): Promise<PlaceRecord>;
}

const peopleCreate = writeOperation('library.people.create', PersonInput);
const peopleUpdate = writeOperation('library.people.update', PersonPatch);
const placesCreate = writeOperation('library.places.create', PlaceInput);

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

  /**
   * The one person edit: `authorize` names the person the caller may edit (or throws), the
   * row is locked and checked against If-Match, and the merge patch is applied to it.
   */
  const editPerson = (
    ctx: RequestContext,
    edit: {
      operation: typeof peopleUpdate;
      body: unknown;
      ifMatch: number | undefined;
      authorize: (tx: Tx, userId: string) => Promise<string>;
    },
  ) => {
    let personId: string | undefined;
    let current: PersonRow | undefined;
    return write(ctx, {
      operation: edit.operation,
      target: null,
      body: edit.body,
      ifMatch: edit.ifMatch,
      authorize: async (tx, c) => {
        personId = await edit.authorize(tx, actingUser(c));
      },
      load: async (tx) => {
        current =
          personId === undefined ? undefined : await lockPerson(forModule(tx, 'library'), personId);
        if (!current) throw new ApiError('not_found');
        return { tripId: null, counter: current.version };
      },
      mutate: async (tx, c, _loaded, patch) => {
        if (!current) throw new Error(`${edit.operation.id} mutated before load`);
        await updatePerson(forModule(tx, 'library'), current.id, {
          ...patched(current, patch, sealContact),
          updatedBy: actingUser(c),
        });
        return personChange(tx, 'update', current.id);
      },
    });
  };

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
        authorize: signedInOnly,
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

    updatePerson: (ctx, personId, body, ifMatch) =>
      editPerson(ctx, {
        operation: peopleUpdate,
        body,
        ifMatch,
        authorize: async (tx, userId) => {
          const row = await findVisiblePerson(forModule(tx, 'library'), userId, personId);
          if (!row) throw new ApiError('not_found');
          const refusal = placeholderEditRefusal(
            { userId: row.user_id, createdBy: row.created_by, erased: row.erased_at !== null },
            userId,
          );
          if (refusal) throw new ApiError(refusal);
          return row.id;
        },
      }),

    createPlace: (ctx, body) =>
      write(ctx, {
        operation: placesCreate,
        target: null,
        body,
        ifMatch: undefined,
        authorize: signedInOnly,
        load: () => Promise.resolve({ tripId: null }),
        mutate: async (tx, c, _loaded, input) => {
          const row = await insertPlace(forModule(tx, 'library'), {
            name: input.name,
            kind: input.kind ?? 'other',
            location: input.location ?? null,
            address: input.address ?? null,
            hours: input.hours ?? null,
            links: input.links ?? [],
            notes: input.notes ?? null,
            createdBy: actingUser(c),
          });
          const place = placeRecord(row);
          const { id, version, createdAt: _c, updatedAt: _u, ...snapshot } = place;
          return {
            action: 'create',
            aggregate: 'place',
            entityId: id,
            tripId: null,
            version,
            snapshot,
            result: place,
          };
        },
      }),
  };
}

function placeRecord(row: PlaceRow): PlaceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PlaceRecord['kind'],
    // numeric comes back as text; the CHECK keeps lat and lng set together.
    location:
      row.lat === null || row.lng === null ? null : { lat: Number(row.lat), lng: Number(row.lng) },
    address: row.address,
    hours: row.hours as OpeningHours | null,
    links: row.links as string[],
    notes: row.notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A person's stored fields with a merge patch applied. The masked value stands for what
 * the caller was shown, not for a value, so writing it back is refused.
 */
function patched(
  row: PersonRow,
  patch: PersonPatch,
  sealContact: (personId: string, contact: EmergencyContact | null) => Buffer | null,
): PersonFields {
  const contact = patch.emergencyContact;
  if (contact && 'masked' in contact) throw new ApiError('masked_field_write');
  const contacts: Record<string, string | null | undefined> = {
    ...contactsOf(row.contacts),
    ...patch.contacts,
  };
  return {
    displayName: patch.displayName ?? row.display_name,
    contacts: Object.fromEntries(
      Object.entries(contacts).filter(([, value]) => typeof value === 'string'),
    ),
    dietary: patch.dietary === undefined ? row.dietary : patch.dietary,
    drivingLicence: patch.drivingLicence ?? row.driving_licence,
    emergencyContactEnc:
      contact === undefined ? row.emergency_contact_enc : sealContact(row.id, contact),
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

/** Library creates: any signed-in user (operations.csv). */
function signedInOnly(_tx: Tx, ctx: RequestContext): Promise<void> {
  return ctx.userId === null ? Promise.reject(new ApiError('unauthenticated')) : Promise.resolve();
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
