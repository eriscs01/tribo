// The retention purge (Technical design, "Retention"; decision 0023): what is due under
// document_retention_days, and how one due file becomes a tombstone. Its own file, as the
// retention rules change for other reasons than the operations on files do.
import { forModule, type DB } from '@tribo/db';
import type { RequestContext } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { dropSnapshots, recordWrite } from '../audit/service.js';
import { documentRetentionDays } from '../identity/service.js';
import { tripsPastRetention } from '../trips/service.js';
import type { BlobStore } from './blobs.js';
import { listDueFiles, lockDueFile, markPurged, type FileRow } from './repo.js';

/** A purged file's snapshot: what it was attached to and who owned it, never its name or content. */
function tombstone(row: FileRow) {
  return {
    tripId: row.trip_id,
    itemId: row.item_id,
    ownerMembershipId: row.owner_membership_id,
    kind: row.kind,
    visibility: row.visibility,
    filename: 'purged',
  };
}

/**
 * Purges every due file, one transaction each, under `ctx` (the job's). A file that fails
 * stays as it was and goes to `onFailure`; the others go on.
 */
export async function purgeDueFiles(
  db: Kysely<DB>,
  blobs: BlobStore,
  ctx: RequestContext,
  onFailure: (fileId: string, error: unknown) => void,
): Promise<{ due: number; purged: number; failed: number }> {
  const days = await documentRetentionDays(db);
  const trips = await tripsPastRetention(db, days);
  const due = await listDueFiles(forModule(db, 'documents'), days, trips);
  let purged = 0;
  let failed = 0;
  for (const fileId of due) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one file per transaction, one at a time
      const done = await db.transaction().execute(async (tx) => {
        const documents = forModule(tx, 'documents');
        // Locked and checked again: purged or no longer due since the list was read.
        const row = await lockDueFile(documents, fileId, days, trips);
        if (!row) return false;
        const version = await markPurged(documents, row.id);
        await dropSnapshots(tx, 'file', row.id);
        await recordWrite(tx, ctx, {
          action: 'purge',
          aggregate: 'file',
          entityId: row.id,
          tripId: row.trip_id,
          version,
          versionBefore: row.version,
          snapshot: tombstone(row),
        });
        // Last, so a failure rolls the row back and the next run tries again.
        await blobs.delete(row.blob_key);
        return true;
      });
      if (done) purged += 1;
    } catch (error) {
      failed += 1;
      onFailure(fileId, error);
    }
  }
  return { due: due.length, purged, failed };
}
