// What the files stories test against: the board world's trip (one member of each role, an
// outsider, a shared guest house owned by the trip owner) plus a private item of another
// member, a blob store on a temporary directory of its own, and file bytes of each allowed
// type. Each call builds a fresh trip and store, so tests never share rows or blobs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import {
  createBlobStore,
  createFilesService,
  writePath,
  type BlobStore,
  type FilesService,
  type UploadPart,
} from '@tribo/core';
import type { Keyring } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import { boardWorld } from './board-world.js';
import type { TestDatabase } from './database.js';
import { createItem } from './factories.js';
import { testKeys } from './keys.js';

/** Leading bytes of each allowed type, as a real file of it begins. */
const SIGNATURES = {
  pdf: Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
};

/** A file of `type` of `size` bytes: its signature, then random bytes. */
export function sample(type: keyof typeof SIGNATURES, size = 4_096): Buffer {
  const head = SIGNATURES[type];
  return Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]);
}

/** An item id as a form or a body names it. */
export const itemRef = (itemId: string) => encodeTypeId(ID_PREFIX.item, itemId);

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The part an adapter would hand the service; `content` defaults to a stream of `data`. */
export function part(
  data: Buffer,
  init: { filename?: string; contentType?: string; content?: Readable } = {},
): UploadPart {
  return {
    filename: init.filename ?? 'document',
    contentType: init.contentType ?? 'application/octet-stream',
    content: init.content ?? Readable.from([data]),
  };
}

export interface BlobDir {
  root: string;
  keys: Keyring;
  blobs: BlobStore;
  /** Every blob on the volume, as blob keys; half-written ones in .tmp count too. */
  stored(): Promise<string[]>;
  remove(): Promise<void>;
}

/** A blob store on a fresh temporary directory; `maxBytes` lowers the ceiling for a test. */
export async function blobDir(options: { maxBytes?: number } = {}): Promise<BlobDir> {
  const root = await mkdtemp(join(tmpdir(), 'tribo-files-'));
  const keys = testKeys();
  return {
    root,
    keys,
    blobs: createBlobStore({ root, keys, ...options }),
    async stored() {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
        .sort();
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

export function filesService(db: Kysely<DB>, blobs: BlobStore): FilesService {
  return createFilesService(db, writePath(db), blobs);
}

export async function filesWorld(tdb: TestDatabase) {
  const w = await boardWorld(tdb);
  const hidden = await createItem(tdb.db, {
    tripId: w.tripId,
    ownerMembershipId: w.other.membershipId,
    type: 'note',
    title: 'Surprise for the owner',
    visibility: 'private',
  });
  return { ...w, hidden };
}

/** The tribo.files row as stored, without its timestamps. */
export function fileRow(tdb: TestDatabase, fileId: string) {
  return tdb.db
    .selectFrom('tribo.files')
    .select([
      'trip_id',
      'item_id',
      'owner_membership_id',
      'kind',
      'sensitive',
      'visibility',
      'filename',
      'mime_type',
      'size_bytes',
      'blob_key',
      'sha256',
      'enc_key_version',
      'purged_at',
      'version',
      'created_by',
      'deleted_at',
    ])
    .where('id', '=', fileId)
    .executeTakeFirst();
}

export async function fileCount(tdb: TestDatabase, tripId: string): Promise<number> {
  const { n } = await tdb.db
    .selectFrom('tribo.files')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('trip_id', '=', tripId)
    .executeTakeFirstOrThrow();
  return Number(n);
}
