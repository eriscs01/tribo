import { forModule } from '@tribo/db';
import { ApiError, type RequestContext, type Tx, type WriteRecord } from '@tribo/platform';
import { insertEvent, insertSnapshot } from './repo.js';

/**
 * The write path's last step: the aggregate's snapshot and its metadata-only event, in the
 * caller's transaction. A retired trip chain refuses the event (audit.chain_event), which
 * rolls the whole write back.
 */
export async function recordWrite(tx: Tx, ctx: RequestContext, record: WriteRecord): Promise<void> {
  const db = forModule(tx, 'audit');
  await insertSnapshot(db, record);
  try {
    await insertEvent(db, ctx, record);
  } catch (error) {
    if (isConstraint(error, 'trip_retired')) throw new ApiError('trip_retired');
    throw error;
  }
}

function isConstraint(error: unknown, name: string): boolean {
  return error instanceof Error && 'constraint' in error && error.constraint === name;
}
