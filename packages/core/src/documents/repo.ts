import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';

/** The documents module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type DocumentsDb = ModuleDb<'documents'>;

/**
 * The id a new file will have, taken before its blob is written: the envelope binds the
 * blob to it (decision 0019).
 */
export async function newFileId(db: DocumentsDb): Promise<string> {
  const { rows } = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(db);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('uuidv7() returned no row');
  return id;
}

export interface NewFile {
  id: string;
  tripId: string;
  itemId: string | null;
  ownerMembershipId: string;
  kind: ValueOf<'tribo.files.kind'>;
  visibility: ValueOf<'tribo.files.visibility'>;
  filename: string;
  mimeType: ValueOf<'tribo.files.mime_type'>;
  sizeBytes: number;
  blobKey: string;
  sha256: string;
  keyVersion: number;
  createdBy: string;
}

const FILE_COLUMNS = [
  'f.id',
  'f.trip_id',
  'f.item_id',
  'f.owner_membership_id',
  'f.kind',
  'f.sensitive',
  'f.visibility',
  'f.filename',
  'f.mime_type',
  'f.size_bytes',
  'f.blob_key',
  'f.sha256',
  'f.purged_at',
  'f.version',
  'f.created_at',
  'f.updated_at',
] as const;

const selectFile = (db: DocumentsDb) => db.selectFrom('tribo.files as f').select(FILE_COLUMNS);

export type FileRow = NonNullable<Awaited<ReturnType<typeof findFile>>>;

export async function insertFile(db: DocumentsDb, file: NewFile): Promise<void> {
  await db
    .insertInto('tribo.files')
    .values({
      id: file.id,
      trip_id: file.tripId,
      item_id: file.itemId,
      owner_membership_id: file.ownerMembershipId,
      kind: file.kind,
      visibility: file.visibility,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      blob_key: file.blobKey,
      sha256: Buffer.from(file.sha256, 'hex'),
      enc_key_version: file.keyVersion,
      created_by: file.createdBy,
      updated_by: file.createdBy,
    })
    .execute();
}

/** For the writer that just created or changed it, inside its transaction. */
export function findFile(db: DocumentsDb, fileId: string) {
  return selectFile(db).where('f.id', '=', fileId).executeTakeFirst();
}

/** Who reads: their account, and their active membership in the trip the files are in. */
export interface FileReader {
  userId: string;
  membershipId: string;
}

/**
 * The one file predicate (Technical design, "Children follow their item"): live files the
 * reader may see, shared or their own, on no item or on one tribo.item_visible lets them
 * see. Every file read composes it; none builds its own filter.
 */
function visibleFiles(db: DocumentsDb, reader: FileReader) {
  return selectFile(db)
    .where('f.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('f.visibility', '=', 'shared'),
        eb('f.owner_membership_id', '=', reader.membershipId),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('f.item_id', 'is', null),
        sql<boolean>`tribo.item_visible(${reader.userId}, f.item_id)`,
      ]),
    );
}

/** One page of a trip's files the reader may see, in id order (UUIDv7: the order they came). */
export function listVisibleFiles(
  db: DocumentsDb,
  reader: FileReader,
  tripId: string,
  page: { limit: number; after: string | null },
) {
  let query = visibleFiles(db, reader).where('f.trip_id', '=', tripId);
  if (page.after !== null) query = query.where('f.id', '>', page.after);
  return query.orderBy('f.id').limit(page.limit).execute();
}
