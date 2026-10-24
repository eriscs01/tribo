// Blobs on the uploads volume that no files row names (decision 0021: a crash between a
// blob's rename and its commit can leave one, as a crash mid-write leaves a `.tmp/` partial).
// Read-only: the operator removes one by hand after checking it, per the runbook.
import { forModule, type DB } from '@tribo/db';
import type { Kysely } from 'kysely';
import type { BlobStore, StoredEntry } from './blobs.js';
import { referencedBlobKeys } from './repo.js';

/** Blob keys looked up per query, so the walk's memory is this many keys, not the volume. */
const BATCH = 500;

/**
 * The blobs and `.tmp/` leftovers at least as old as `olderThan` that no files row names, in
 * volume order. The age keeps an upload that has stored its blob and not yet committed out of
 * the list.
 */
export async function* unreferencedBlobs(
  db: Kysely<DB>,
  blobs: BlobStore,
  olderThan: Date,
  onIgnored: () => void,
): AsyncGenerator<StoredEntry> {
  const documents = forModule(db, 'documents');
  let batch: StoredEntry[] = [];
  const flush = async function* flush(): AsyncGenerator<StoredEntry> {
    const named = await referencedBlobKeys(
      documents,
      batch.filter((entry) => !entry.leftover).map((entry) => entry.key),
    );
    for (const entry of batch) if (!named.has(entry.key)) yield entry;
    batch = [];
  };
  for await (const entry of blobs.list(olderThan, onIgnored)) {
    batch.push(entry);
    if (batch.length >= BATCH) yield* flush();
  }
  yield* flush();
}
