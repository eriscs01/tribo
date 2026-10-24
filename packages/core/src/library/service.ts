import {
  decodeTypeId,
  ID_PREFIX,
  PersonInput,
  PersonPatch,
  PlaceInput,
  VendorInput,
  type Contacts,
  type EmergencyContact,
  type OpeningHours,
} from '@tribo/contract';
import type { Keyring } from '@tribo/crypto';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  actingUser,
  ApiError,
  type Change,
  type RequestContext,
  type Tx,
  type WritePath,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { writeOperation } from '../write-operation.js';
import { ownEditRefusal, placeholderEditRefusal, type EditablePerson } from './policy.js';
import {
  findAccountPerson,
  findOwnPerson,
  findPerson,
  findPersons,
  findPersonAccount,
  findVisiblePerson,
  insertAccountPerson,
  insertPlace,
  insertPlaceholder,
  insertVendor,
  lockPerson,
  mergePlaceholder,
  newRowId,
  resolvePlaceId,
  searchPlaces,
  searchVendors,
  searchVisiblePersons,
  type NameSearch,
  updatePerson,
  type PersonFields,
  type PersonRow,
  type PlaceRow,
  type VendorRow,
} from './repo.js';
import { sealedContact } from './sealed.js';

export {
  createPersonRevealService,
  type PersonRevealService,
  type SharedTripRoles,
} from './reveal.js';

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

export interface VendorRecord {
  id: string;
  name: string;
  kind: ValueOf<'tribo.vendors.kind'>;
  placeId: string | null;
  contacts: Contacts;
  links: string[];
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One library.search match. */
export type LibraryHitRecord =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'place'; id: string; name: string; placeKind: ValueOf<'tribo.places.kind'> }
  | { kind: 'vendor'; id: string; name: string; vendorKind: ValueOf<'tribo.vendors.kind'> };

export interface LibraryService {
  /**
   * library.search: the best `limit` name matches across people (tribo.person_visible only),
   * places and vendors.
   */
  search(userId: string, search: NameSearch): Promise<LibraryHitRecord[]>;
  /** library.people.create: a placeholder traveller the caller creates and alone edits. */
  createPerson(ctx: RequestContext, body: unknown): Promise<PersonRecord>;
  /** library.people.get: not_found unless tribo.person_visible lets the caller see it. */
  getPerson(userId: string, personId: string): Promise<PersonRecord>;
  /** me.get: the account's own person; not_found if it has none (an erased account). */
  ownPerson(userId: string): Promise<PersonRecord>;
  /** library.people.update: a placeholder, by its creator, under If-Match on its version. */
  updatePerson(
    ctx: RequestContext,
    personId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<PersonRecord>;
  /** me.update: the caller's own person, under If-Match on its version. */
  updateOwnPerson(
    ctx: RequestContext,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<PersonRecord>;
  /** library.places.create: any signed-in user adds to the one shared library (G11). */
  createPlace(ctx: RequestContext, body: unknown): Promise<PlaceRecord>;
  /** library.vendors.create: any signed-in user adds to the one shared library (G11). */
  createVendor(ctx: RequestContext, body: unknown): Promise<VendorRecord>;
}

const peopleCreate = writeOperation('library.people.create', PersonInput);
const peopleUpdate = writeOperation('library.people.update', PersonPatch);
const meUpdate = writeOperation('me.update', PersonPatch);
const placesCreate = writeOperation('library.places.create', PlaceInput);
const vendorsCreate = writeOperation('library.vendors.create', VendorInput);

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createLibraryService(
  db: Kysely<DB>,
  write: WritePath,
  keys: Keyring,
): LibraryService {
  const sealContact = (personId: string, contact: EmergencyContact | null) =>
    sealedContact(keys, personId, contact);

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
    async search(userId, search) {
      const library = forModule(db, 'library');
      const [people, places, vendors] = await Promise.all([
        searchVisiblePersons(library, userId, search),
        searchPlaces(library, search),
        searchVendors(library, search),
      ]);
      const scored: { score: number; hit: LibraryHitRecord }[] = [
        ...people.map((r) => ({
          score: r.score,
          hit: { kind: 'person' as const, id: r.id, name: r.name },
        })),
        ...places.map((r) => ({
          score: r.score,
          hit: {
            kind: 'place' as const,
            id: r.id,
            name: r.name,
            placeKind: r.kind as ValueOf<'tribo.places.kind'>,
          },
        })),
        ...vendors.map((r) => ({
          score: r.score,
          hit: {
            kind: 'vendor' as const,
            id: r.id,
            name: r.name,
            vendorKind: r.kind as ValueOf<'tribo.vendors.kind'>,
          },
        })),
      ];
      return scored
        .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
        .slice(0, search.limit)
        .map(({ hit }) => hit);
    },

    async ownPerson(userId) {
      const row = await findOwnPerson(forModule(db, 'library'), userId);
      if (!row) throw new ApiError('not_found');
      return personRecord(row);
    },

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
        mutate: (tx, c, _loaded, input) =>
          createPlaceholder(tx, keys, { createdBy: actingUser(c), person: input }),
      }),

    updatePerson: (ctx, personId, body, ifMatch) =>
      editPerson(ctx, {
        operation: peopleUpdate,
        body,
        ifMatch,
        authorize: async (tx, userId) => {
          const row = await findVisiblePerson(forModule(tx, 'library'), userId, personId);
          if (!row) throw new ApiError('not_found');
          const refusal = placeholderEditRefusal(editable(row), userId);
          if (refusal) throw new ApiError(refusal);
          return row.id;
        },
      }),

    updateOwnPerson: (ctx, body, ifMatch) =>
      editPerson(ctx, {
        operation: meUpdate,
        body,
        ifMatch,
        authorize: async (tx, userId) => {
          const row = await findOwnPerson(forModule(tx, 'library'), userId);
          if (!row) throw new ApiError('not_found');
          const refusal = ownEditRefusal(editable(row));
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

    createVendor: (ctx, body) =>
      write(ctx, {
        operation: vendorsCreate,
        target: null,
        body,
        ifMatch: undefined,
        authorize: signedInOnly,
        load: () => Promise.resolve({ tripId: null }),
        mutate: async (tx, c, _loaded, input) => {
          const library = forModule(tx, 'library');
          let placeId: string | null = null;
          if (input.placeId !== undefined) {
            placeId =
              (await resolvePlaceId(library, decodeTypeId(ID_PREFIX.place, input.placeId))) ?? null;
            if (placeId === null) {
              throw new ApiError('validation_failed', {
                errors: [{ path: '/placeId', message: 'no such place' }],
              });
            }
          }
          const row = await insertVendor(library, {
            name: input.name,
            kind: input.kind ?? 'other',
            placeId,
            contacts: input.contacts ?? {},
            links: input.links ?? [],
            notes: input.notes ?? null,
            createdBy: actingUser(c),
          });
          const vendor = vendorRecord(row);
          const { id, version, createdAt: _c, updatedAt: _u, ...snapshot } = vendor;
          return {
            action: 'create',
            aggregate: 'vendor',
            entityId: id,
            tripId: null,
            version,
            snapshot,
            result: vendor,
          };
        },
      }),
  };
}

function vendorRecord(row: VendorRow): VendorRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as VendorRecord['kind'],
    placeId: row.place_id,
    contacts: contactsOf(row.contacts),
    links: row.links as string[],
    notes: row.notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function editable(row: PersonRow): EditablePerson {
  return { userId: row.user_id, createdBy: row.created_by, erased: row.erased_at !== null };
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

/** Library creates: any signed-in user (the registry). */
function signedInOnly(_tx: Tx, ctx: RequestContext): Promise<void> {
  return ctx.userId === null ? Promise.reject(new ApiError('unauthenticated')) : Promise.resolve();
}

/**
 * Every account has exactly one person, made with the account. Returns the person's
 * create as a change for the caller to record in the same transaction.
 */
export async function createAccountPerson(
  tx: Tx,
  account: { userId: string; displayName: string },
): Promise<Change<{ personId: string }>> {
  const { id } = await insertAccountPerson(
    forModule(tx, 'library'),
    account.userId,
    account.displayName,
  );
  return { ...(await personChange(tx, 'create', id)), result: { personId: id } };
}

/** The person an account is inside every trip, through its memberships; null if it has none. */
export async function accountPersonId(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await findAccountPerson(forModule(db, 'library'), userId);
  return row?.id ?? null;
}

/**
 * The persons behind a trip's memberships, by id, as members.list shows them. The caller
 * has checked it shares the trip with them, which is what tribo.person_visible asks.
 */
export async function memberPersons(
  db: Kysely<DB>,
  personIds: readonly string[],
): Promise<Map<string, PersonRecord>> {
  if (personIds.length === 0) return new Map();
  const rows = await findPersons(forModule(db, 'library'), personIds);
  return new Map(rows.map((row) => [row.id, personRecord(row)]));
}

/**
 * A placeholder traveller its creator alone edits, written in the caller's transaction:
 * library.people.create, and members.add for a new traveller. Returns the person's create
 * as a change for the caller to record.
 */
export async function createPlaceholder(
  tx: Tx,
  keys: Keyring,
  placeholder: { createdBy: string; person: PersonInput },
): Promise<Change<PersonRecord>> {
  const { person } = placeholder;
  const library = forModule(tx, 'library');
  const id = await newRowId(library);
  await insertPlaceholder(library, {
    id,
    createdBy: placeholder.createdBy,
    displayName: person.displayName,
    contacts: person.contacts ?? {},
    dietary: person.dietary ?? null,
    drivingLicence: person.drivingLicence ?? false,
    emergencyContactEnc: sealedContact(keys, id, person.emergencyContact ?? null),
  });
  return personChange(tx, 'create', id);
}

/** The person if tribo.person_visible lets this account see it (a merged id resolves), or null. */
export async function visiblePerson(
  db: Kysely<DB>,
  userId: string,
  personId: string,
): Promise<PersonRecord | null> {
  const row = await findVisiblePerson(forModule(db, 'library'), userId, personId);
  return row ? personRecord(row) : null;
}

/**
 * R28: a placeholder whose last membership row was claimed is scrubbed, soft-deleted and
 * merged into the claimer's person, in the claim's transaction; its old id resolves to the
 * survivor from then on. Returns the merge for the caller's write to record.
 */
export async function mergeClaimedPlaceholder(
  tx: Tx,
  merge: { personId: string; into: string; by: string },
): Promise<WriteRecord> {
  const row = await mergePlaceholder(forModule(tx, 'library'), merge);
  return {
    action: 'merge',
    aggregate: 'person',
    entityId: row.id,
    tripId: null,
    versionBefore: row.version - 1,
    version: row.version,
    snapshot: { ...personSnapshot(row), mergedInto: row.merged_into },
  };
}

/** The account a person is, inside every trip it is a member of; null for a placeholder. */
export async function personAccountId(db: Kysely<DB>, personId: string): Promise<string | null> {
  const row = await findPersonAccount(forModule(db, 'library'), personId);
  return row?.user_id ?? null;
}
