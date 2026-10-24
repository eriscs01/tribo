// The documents module: files of a trip, their metadata in tribo.files and their bytes in
// the blob store (Technical design, "Documents, encryption and retention").
import { pipeline as pipe, type Readable } from 'node:stream';
import {
  decodeTypeId,
  FilePatch,
  FileUploadForm,
  FileUploadInput,
  ID_PREFIX,
  NoBody,
  type PageQuery,
} from '@tribo/contract';
import { forModule, type DB, type TripRole, type ValueOf } from '@tribo/db';
import {
  actingUser,
  ApiError,
  page,
  uuidCursor,
  validate,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { recordEvent } from '../audit/service.js';
import { visibleItemTrip } from '../items/service.js';
import { callerMembership, memberTrip, type CallerMembership } from '../trips/service.js';
import { inTransaction } from '../transaction.js';
import { writeOperation } from '../write-operation.js';
import type { BlobStore, StoredBlob } from './blobs.js';
import {
  canDeleteFile,
  canDownloadFile,
  canGetFile,
  canListFiles,
  canUpdateFile,
  canUploadFile,
} from './policy.js';
import { purgeDueFiles } from './purge.js';
import {
  fileTrip,
  findFile,
  findVisibleFile,
  insertFile,
  listVisibleFiles,
  lockFile,
  newFileId,
  softDeleteFile,
  updateFile,
  type FileRow,
} from './repo.js';
import { displayName, nameRefusal, sniffer, typeRefusal, type FileMime } from './sniff.js';

export { createBlobStore, type BlobStore, type StoredBlob } from './blobs.js';

/** A file's metadata as the documents service answers it. */
export interface FileRecord {
  id: string;
  tripId: string;
  itemId: string | null;
  ownerMembershipId: string;
  kind: ValueOf<'tribo.files.kind'>;
  sensitive: boolean;
  visibility: ValueOf<'tribo.files.visibility'>;
  filename: string;
  mimeType: ValueOf<'tribo.files.mime_type'>;
  sizeBytes: number;
  /** Of the plaintext, in hex. */
  sha256: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  purgedAt: Date | null;
}

/** The file part of an upload as the adapter receives it: what the client claims, and the bytes. */
export interface UploadPart {
  /** The client's name for it; only a label, never trusted for a path or a type. */
  filename: string;
  /** The part's declared Content-Type; refused only when the bytes contradict it. */
  contentType: string;
  content: Readable;
}

export interface FilesService {
  /**
   * files.list: the trip's files the caller may see, oldest first; not_found unless they
   * are an active member of the live trip.
   */
  list(
    userId: string,
    tripId: string,
    query: PageQuery,
  ): Promise<{ items: FileRecord[]; nextCursor: string | null }>;
  /** files.get: one file files.list would show the caller; not_found for any other. */
  get(userId: string, fileId: string): Promise<FileRecord>;
  /**
   * files.upload: checks the form, the caller and the item before reading a byte, then
   * streams the bytes through the type sniffer into the blob store and records the row.
   * A write that does not commit (a refusal, a replayed Idempotency-Key) removes the blob.
   */
  upload(ctx: RequestContext, tripId: string, form: unknown, file: UploadPart): Promise<FileRecord>;
  /** files.update: merge-patches the name, item or visibility under If-Match = version. */
  update(
    ctx: RequestContext,
    fileId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<FileRecord>;
  /**
   * files.download: the file's bytes, to whoever may see it at this moment (looked up afresh
   * on every call), as a stream that fails rather than yield bytes that do not authenticate.
   * A purged file is file_purged; a sensitive one is recorded as a reveal of its content
   * before the stream is opened.
   */
  download(ctx: RequestContext, fileId: string): Promise<{ file: FileRecord; content: Readable }>;
  /**
   * The daily retention purge (decision 0023): every due file, one transaction each, its
   * blob deleted by the key on its row and a content-free tombstone recorded under
   * `ctx` (the job's). A file that fails stays as it was and is handed to `onFailure`;
   * the others go on. Safe to repeat.
   */
  purgeDue(
    ctx: RequestContext,
    onFailure: (fileId: string, error: unknown) => void,
  ): Promise<{ due: number; purged: number; failed: number }>;
  /** files.delete: a soft delete under If-Match; the blob stays until the retention purge. */
  delete(
    ctx: RequestContext,
    fileId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<void>;
}

const filesUpload = writeOperation('files.upload', FileUploadInput);
const filesUpdate = writeOperation('files.update', FilePatch);
const filesDelete = writeOperation('files.delete', NoBody);

function fileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    itemId: row.item_id,
    ownerMembershipId: row.owner_membership_id,
    kind: row.kind as FileRecord['kind'],
    sensitive: row.sensitive === true,
    visibility: row.visibility as FileRecord['visibility'],
    filename: row.filename,
    mimeType: row.mime_type as FileRecord['mimeType'],
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256.toString('hex'),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    purgedAt: row.purged_at,
  };
}

/**
 * The trip's files as `viewer` (the caller's active membership in the trip) may see them,
 * through the one file predicate, the first `limit` in id order: the offline bundle's file
 * metadata. A purged file shows as purged; no blob is read.
 */
export async function tripFiles(
  db: Kysely<DB>,
  userId: string,
  viewer: CallerMembership,
  tripId: string,
  limit: number,
): Promise<FileRecord[]> {
  if (!canListFiles(viewer.role)) return [];
  const rows = await listVisibleFiles(
    forModule(db, 'documents'),
    { userId, membershipId: viewer.id },
    tripId,
    { limit, after: null },
  );
  return rows.map(fileRecord);
}

/** The file aggregate's snapshot: its metadata as restore would copy it (never the blob key). */
function fileSnapshot(row: FileRow) {
  return {
    tripId: row.trip_id,
    itemId: row.item_id,
    ownerMembershipId: row.owner_membership_id,
    kind: row.kind,
    visibility: row.visibility,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256.toString('hex'),
  };
}

/**
 * The item a file attaches to: one the caller sees (tribo.item_visible) in the file's trip.
 * A hidden item, one of another trip and one that does not exist are refused alike.
 */
async function attachableItem(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  itemId: string,
): Promise<string> {
  const id = decodeTypeId(ID_PREFIX.item, itemId);
  if ((await visibleItemTrip(db, userId, id)) !== tripId) {
    throw new ApiError('validation_failed', {
      errors: [{ path: '/itemId', message: 'no such item in this trip' }],
    });
  }
  return id;
}

/** Stands in for the trip of a file that does not exist, so its lookup still runs. */
const NO_ROW = '00000000-0000-0000-0000-000000000000';

/**
 * A file the reader may see, with their membership in its trip, or not_found. The same
 * queries run whether the file is theirs to see, hidden, in another trip or unknown, so
 * neither the answer nor its cost tells them apart.
 */
async function readableFile(
  db: Kysely<DB>,
  userId: string,
  fileId: string,
  allowed: (role: TripRole) => boolean,
): Promise<{ row: FileRow; membership: CallerMembership }> {
  const documents = forModule(db, 'documents');
  const membership = await callerMembership(
    db,
    userId,
    (await fileTrip(documents, fileId)) ?? NO_ROW,
  );
  const row = await findVisibleFile(
    documents,
    { userId, membershipId: membership?.id ?? NO_ROW },
    fileId,
  );
  if (!row || !membership) throw new ApiError('not_found');
  if (!allowed(membership.role)) throw new ApiError('forbidden');
  return { row, membership };
}

/**
 * Who is acting on a file they can see: their account and membership, and whether `allowed`
 * lets them. A file they cannot see does not exist for them, before any role is weighed.
 */
async function actingOnFile(
  tx: Tx,
  ctx: RequestContext,
  fileId: string,
  allowed: (editor: { role: TripRole; owns: boolean }) => boolean,
) {
  const userId = actingUser(ctx);
  const { row, membership } = await readableFile(tx, userId, fileId, () => true);
  if (!allowed({ role: membership.role, owns: row.owner_membership_id === membership.id })) {
    throw new ApiError('forbidden');
  }
  return { userId, membership };
}

/** The write path's load for one file: the live row, locked until commit. */
async function lockedFile(tx: Tx, target: { fileId: string }) {
  const row = await lockFile(forModule(tx, 'documents'), target.fileId);
  if (!row) throw new ApiError('not_found');
  return { tripId: row.trip_id, counter: row.version, row };
}

/** A new name for a file of this type: shown as an upload's would be, and keeping its type. */
function renamed(name: string, type: FileMime): string {
  const shown = displayName(name, type);
  const refusal = nameRefusal(shown, type);
  if (refusal) throw new ApiError(refusal);
  return shown;
}

/** The caller adding a file to the trip: their active membership, which a viewer's is not. */
async function uploader(tx: Tx, userId: string, tripId: string): Promise<CallerMembership> {
  const membership = await callerMembership(tx, userId, tripId);
  if (membership === null) throw new ApiError('not_found');
  if (!canUploadFile(membership.role)) throw new ApiError('forbidden');
  return membership;
}

/** Removes the blob of an upload whose write did not commit; failing that, says which blob is left. */
async function discard(blobs: BlobStore, fileId: string, stored: StoredBlob, cause: unknown) {
  try {
    await blobs.delete(stored.blobKey);
  } catch (error) {
    const why = cause instanceof ApiError ? cause.code : 'an error';
    throw new Error(
      `file ${fileId} did not commit (${why}) and its blob ${stored.blobKey} is left`,
      { cause: error },
    );
  }
}

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createFilesService(
  db: Kysely<DB>,
  write: WritePath,
  blobs: BlobStore,
): FilesService {
  return {
    async list(userId, tripId, query) {
      const membership = await callerMembership(db, userId, tripId);
      if (membership === null) throw new ApiError('not_found');
      if (!canListFiles(membership.role)) throw new ApiError('forbidden');
      const rows = await listVisibleFiles(
        forModule(db, 'documents'),
        { userId, membershipId: membership.id },
        tripId,
        {
          limit: query.limit + 1,
          after: query.cursor === undefined ? null : uuidCursor(query.cursor),
        },
      );
      const shown = page(rows, query.limit, (row) => [row.id]);
      return { items: shown.rows.map(fileRecord), nextCursor: shown.nextCursor };
    },

    async get(userId, fileId) {
      return fileRecord((await readableFile(db, userId, fileId, canGetFile)).row);
    },

    update(ctx, fileId, body, ifMatch) {
      return write(ctx, {
        operation: filesUpdate,
        target: { fileId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnFile(tx, c, target.fileId, canUpdateFile),
        load: lockedFile,
        mutate: async (tx, _c, { row }, patch, { userId }) => {
          // Its bytes are gone, and so is any name it had: a purged file stays as it is.
          if (row.purged_at !== null) throw new ApiError('file_purged');
          const { itemId } = patch;
          const documents = forModule(tx, 'documents');
          const version = await updateFile(
            documents,
            row.id,
            {
              ...(patch.filename === undefined
                ? {}
                : { filename: renamed(patch.filename, row.mime_type as FileMime) }),
              ...(itemId === undefined
                ? {}
                : {
                    itemId:
                      itemId === null
                        ? null
                        : await attachableItem(tx, userId, row.trip_id, itemId),
                  }),
              ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
            },
            userId,
          );
          const changed = await findFile(documents, row.id);
          if (!changed) throw new Error(`file ${row.id} vanished inside its own write`);
          return {
            action: 'update',
            aggregate: 'file',
            entityId: row.id,
            tripId: row.trip_id,
            version,
            snapshot: fileSnapshot(changed),
            result: fileRecord(changed),
          };
        },
      });
    },

    delete(ctx, fileId, body, ifMatch) {
      return write(ctx, {
        operation: filesDelete,
        target: { fileId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnFile(tx, c, target.fileId, canDeleteFile),
        load: lockedFile,
        mutate: async (tx, _c, { row }, _input, { userId }) => {
          const documents = forModule(tx, 'documents');
          const version = await softDeleteFile(documents, row.id, userId);
          return {
            action: 'delete',
            aggregate: 'file',
            entityId: row.id,
            tripId: row.trip_id,
            version,
            // The file as it was: restore (1b) copies this snapshot forward.
            snapshot: fileSnapshot(row),
            result: undefined,
          };
        },
      });
    },

    async download(ctx, fileId) {
      const userId = actingUser(ctx);
      const row = await inTransaction(db, async (tx) => {
        const found = (await readableFile(tx, userId, fileId, canDownloadFile)).row;
        if (found.purged_at !== null) throw new ApiError('file_purged');
        if (found.sensitive === true) {
          // As a reveal of a sensitive field: what was read, never what it said (decision 0022).
          await recordEvent(tx, ctx, {
            action: 'reveal',
            entityType: 'file',
            entityId: found.id,
            tripId: found.trip_id,
            reason: 'content',
          });
        }
        return found;
      });
      return { file: fileRecord(row), content: blobs.read(row.id, row.blob_key) };
    },

    purgeDue: (ctx, onFailure) => purgeDueFiles(db, blobs, ctx, onFailure),

    async upload(ctx, tripId, form, file) {
      const userId = actingUser(ctx);
      const fields = validate(FileUploadForm, form);
      // Everything that can be refused without the bytes is, before a byte is read.
      const { trip } = await memberTrip(db, userId, tripId, canUploadFile);
      if (trip.status === 'archived') throw new ApiError('trip_archived');
      if (fields.itemId !== undefined) await attachableItem(db, userId, tripId, fields.itemId);

      const fileId = await newFileId(forModule(db, 'documents'));
      const sniff = sniffer((type) =>
        typeRefusal(type, {
          contentType: file.contentType,
          filename: displayName(file.filename, type),
        }),
      );
      const stored = await blobs.write(
        fileId,
        pipe(file.content, sniff, () => {
          // Errors reach blobs.write through the returned stream.
        }),
      );
      const mimeType = sniff.type();
      try {
        return await write(ctx, {
          operation: filesUpload,
          target: { tripId },
          // What the Idempotency-Key hashes: the form as sent and the file as stored.
          body: {
            ...(form as object),
            file: {
              filename: displayName(file.filename, mimeType),
              mimeType,
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
            },
          },
          ifMatch: undefined,
          authorize: (tx, c, target) => uploader(tx, actingUser(c), target.tripId),
          // The item is checked again: it may have changed while the bytes arrived.
          load: async (tx, target, input) => ({
            tripId: target.tripId,
            itemId:
              input.itemId === undefined
                ? null
                : await attachableItem(tx, userId, target.tripId, input.itemId),
          }),
          mutate: async (tx, _c, loaded, input, membership) => {
            const documents = forModule(tx, 'documents');
            await insertFile(documents, {
              id: fileId,
              tripId: loaded.tripId,
              itemId: loaded.itemId,
              ownerMembershipId: membership.id,
              kind: input.kind,
              visibility: input.visibility,
              filename: input.file.filename,
              mimeType: input.file.mimeType,
              sizeBytes: input.file.sizeBytes,
              blobKey: stored.blobKey,
              sha256: input.file.sha256,
              keyVersion: stored.keyVersion,
              createdBy: userId,
            });
            const row = await findFile(documents, fileId);
            if (!row) throw new Error(`file ${fileId} vanished inside its own write`);
            return {
              action: 'create',
              aggregate: 'file',
              entityId: fileId,
              tripId: loaded.tripId,
              version: row.version,
              snapshot: fileSnapshot(row),
              result: fileRecord(row),
            };
          },
        });
      } catch (error) {
        await discard(blobs, fileId, stored, error);
        throw error;
      }
    },
  };
}
