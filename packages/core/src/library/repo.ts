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
    .returning('id')
    .executeTakeFirstOrThrow();
}

/**
 * The account's own person. Only merged placeholders are ever soft-deleted, and
 * tribo.is_member and tribo.item_visible ignore persons.deleted_at, so this does too:
 * a membership check here never disagrees with the visibility predicates.
 */
export function findAccountPerson(db: LibraryDb, userId: string) {
  return db
    .selectFrom('tribo.persons')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

/** The account behind a person, whatever its state; undefined for an unknown person. */
export function findPersonAccount(db: LibraryDb, personId: string) {
  return db
    .selectFrom('tribo.persons')
    .select('user_id')
    .where('id', '=', personId)
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

/** An account's own live person, with every field. */
export function findOwnPerson(db: LibraryDb, userId: string) {
  return db
    .selectFrom('tribo.persons as p')
    .select(PERSON_COLUMNS)
    .where('p.user_id', '=', userId)
    .where('p.deleted_at', 'is', null)
    .executeTakeFirst();
}

/** A live person, locked until commit, for the write that changes it. */
export function lockPerson(db: LibraryDb, personId: string) {
  return findLivePerson(db, personId).forUpdate().executeTakeFirst();
}

/** A live person, for the writer that holds it or just created it. */
export function findPerson(db: LibraryDb, personId: string) {
  return findLivePerson(db, personId).executeTakeFirst();
}

/**
 * The persons behind these memberships, whatever their state: tribo.is_member ignores
 * persons.deleted_at, so a trip's member list does too (findAccountPerson says why).
 */
export function findPersons(db: LibraryDb, personIds: readonly string[]) {
  return db
    .selectFrom('tribo.persons as p')
    .select(PERSON_COLUMNS)
    .where('p.id', 'in', personIds)
    .execute();
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

/**
 * The place a new reference should point at: the place itself while live, or the survivor
 * of a merge (chains stay one hop). Undefined for an unknown or deleted place.
 */
export async function resolvePlaceId(db: LibraryDb, placeId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('tribo.places')
    .select((eb) => eb.fn.coalesce('merged_into', 'id').as('id'))
    .where('id', '=', placeId)
    .where((eb) => eb.or([eb('deleted_at', 'is', null), eb('merged_into', 'is not', null)]))
    .executeTakeFirst();
  return row?.id;
}

export interface NewVendor {
  name: string;
  kind: ValueOf<'tribo.vendors.kind'>;
  placeId: string | null;
  contacts: Contacts;
  links: Links;
  notes: string | null;
  createdBy: string;
}

export function insertVendor(db: LibraryDb, vendor: NewVendor) {
  return db
    .insertInto('tribo.vendors')
    .values({
      name: vendor.name,
      kind: vendor.kind,
      place_id: vendor.placeId,
      contacts: jsonb(vendor.contacts),
      links: jsonb(vendor.links),
      notes: vendor.notes,
      created_by: vendor.createdBy,
      updated_by: vendor.createdBy,
    })
    .returning([
      'id',
      'name',
      'kind',
      'place_id',
      'contacts',
      'links',
      'notes',
      'version',
      'created_at',
      'updated_at',
    ])
    .executeTakeFirstOrThrow();
}

export type VendorRow = Awaited<ReturnType<typeof insertVendor>>;

/** A name search: a substring match or a close spelling, best word similarity first. */
export interface NameSearch {
  q: string;
  limit: number;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const nameMatches = (column: string, q: string) =>
  sql<boolean>`(${sql.ref(column)} ILIKE ${likePattern(q)} OR ${q} <% ${sql.ref(column)})`;

const nameScore = (column: string, q: string) =>
  sql<number>`word_similarity(${q}, ${sql.ref(column)})`;

/** People this account may see (tribo.person_visible, the one person predicate) by name. */
export function searchVisiblePersons(db: LibraryDb, userId: string, search: NameSearch) {
  return db
    .selectFrom('tribo.persons as p')
    .select(['p.id', 'p.display_name as name', nameScore('p.display_name', search.q).as('score')])
    .where(nameMatches('p.display_name', search.q))
    .where(sql<boolean>`tribo.person_visible(${userId}, p.id)`)
    .orderBy('score', 'desc')
    .orderBy('p.id')
    .limit(search.limit)
    .execute();
}

export function searchPlaces(db: LibraryDb, search: NameSearch) {
  return db
    .selectFrom('tribo.places as pl')
    .select(['pl.id', 'pl.name', 'pl.kind', nameScore('pl.name', search.q).as('score')])
    .where('pl.deleted_at', 'is', null)
    .where(nameMatches('pl.name', search.q))
    .orderBy('score', 'desc')
    .orderBy('pl.id')
    .limit(search.limit)
    .execute();
}

export function searchVendors(db: LibraryDb, search: NameSearch) {
  return db
    .selectFrom('tribo.vendors as v')
    .select(['v.id', 'v.name', 'v.kind', nameScore('v.name', search.q).as('score')])
    .where('v.deleted_at', 'is', null)
    .where(nameMatches('v.name', search.q))
    .orderBy('score', 'desc')
    .orderBy('v.id')
    .limit(search.limit)
    .execute();
}
