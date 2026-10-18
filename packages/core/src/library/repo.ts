import type { Contacts, Links, OpeningHours } from '@tribo/contract';
import type { Json, ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';

/** The library module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type LibraryDb = ModuleDb<'library'>;

/** A JSON value bound as jsonb; node-postgres would send a bare array as a PostgreSQL array. */
const jsonb = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

/** An account's own person: user_id set forever, created by the account itself. */
export function insertAccountPerson(db: LibraryDb, userId: string, displayName: string) {
  return db
    .insertInto('tribo.persons')
    .values({ user_id: userId, display_name: displayName, created_by: userId })
    .returning(['id', 'user_id', 'display_name', 'version'])
    .executeTakeFirstOrThrow();
}

/** The live person of an account, or undefined (an erased or deleted account has none). */
export function findAccountPerson(db: LibraryDb, userId: string) {
  return db
    .selectFrom('tribo.persons')
    .select('id')
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/**
 * A fresh row id, taken before the insert: a sensitive value is sealed to its row id (AAD),
 * so the id must be known when the row is written.
 */
export async function newRowId(db: LibraryDb): Promise<string> {
  const { rows } = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(db);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('uuidv7() returned no row');
  return id;
}

/** The person fields a placeholder's creator, or an account for its own person, writes. */
export interface PersonFields {
  displayName: string;
  contacts: Contacts;
  dietary: string | null;
  drivingLicence: boolean;
  emergencyContactEnc: Buffer | null;
}

export async function insertPlaceholder(
  db: LibraryDb,
  person: PersonFields & { id: string; createdBy: string },
): Promise<void> {
  await db
    .insertInto('tribo.persons')
    .values({
      id: person.id,
      display_name: person.displayName,
      contacts: jsonb(person.contacts),
      dietary: person.dietary,
      driving_licence: person.drivingLicence,
      emergency_contact_enc: person.emergencyContactEnc,
      created_by: person.createdBy,
      updated_by: person.createdBy,
    })
    .execute();
}

const PERSON_COLUMNS = [
  'p.id',
  'p.user_id',
  'p.display_name',
  'p.contacts',
  'p.dietary',
  'p.driving_licence',
  'p.emergency_contact_enc',
  'p.created_by',
  'p.erased_at',
  'p.version',
  'p.created_at',
  'p.updated_at',
] as const;

export type PersonRow = NonNullable<Awaited<ReturnType<typeof findPerson>>>;

/** A live person, locked until commit, for the write that changes it. */
export function lockPerson(db: LibraryDb, personId: string) {
  return findLivePerson(db, personId).forUpdate().executeTakeFirst();
}

/** A live person, for the writer that holds it or just created it. */
export function findPerson(db: LibraryDb, personId: string) {
  return findLivePerson(db, personId).executeTakeFirst();
}

function findLivePerson(db: LibraryDb, personId: string) {
  return db
    .selectFrom('tribo.persons as p')
    .select(PERSON_COLUMNS)
    .where('p.id', '=', personId)
    .where('p.deleted_at', 'is', null);
}

export async function updatePerson(
  db: LibraryDb,
  personId: string,
  person: PersonFields & { updatedBy: string },
): Promise<void> {
  await db
    .updateTable('tribo.persons')
    .set((eb) => ({
      display_name: person.displayName,
      contacts: jsonb(person.contacts),
      dietary: person.dietary,
      driving_licence: person.drivingLicence,
      emergency_contact_enc: person.emergencyContactEnc,
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
      updated_by: person.updatedBy,
    }))
    .where('id', '=', personId)
    .execute();
}

/**
 * The person if tribo.person_visible lets this account see it. A merged id resolves to its
 * survivor first (merges keep chains one hop), and the survivor must be visible itself.
 */
export function findVisiblePerson(db: LibraryDb, userId: string, personId: string) {
  return db
    .selectFrom('tribo.persons as p')
    .select(PERSON_COLUMNS)
    .where('p.id', '=', (eb) =>
      eb
        .selectFrom('tribo.persons as m')
        .select((m) => m.fn.coalesce('m.merged_into', 'm.id').as('id'))
        .where('m.id', '=', personId),
    )
    .where(sql<boolean>`tribo.person_visible(${userId}, p.id)`)
    .executeTakeFirst();
}

export interface NewPlace {
  name: string;
  kind: ValueOf<'tribo.places.kind'>;
  location: { lat: number; lng: number } | null;
  address: string | null;
  hours: OpeningHours | null;
  links: Links;
  notes: string | null;
  createdBy: string;
}

export function insertPlace(db: LibraryDb, place: NewPlace) {
  return db
    .insertInto('tribo.places')
    .values({
      name: place.name,
      kind: place.kind,
      lat: place.location?.lat ?? null,
      lng: place.location?.lng ?? null,
      address: place.address,
      hours: place.hours === null ? null : jsonb(place.hours),
      links: jsonb(place.links),
      notes: place.notes,
      created_by: place.createdBy,
      updated_by: place.createdBy,
    })
    .returning([
      'id',
      'name',
      'kind',
      'lat',
      'lng',
      'address',
      'hours',
      'links',
      'notes',
      'version',
      'created_at',
      'updated_at',
    ])
    .executeTakeFirstOrThrow();
}

export type PlaceRow = Awaited<ReturnType<typeof insertPlace>>;
