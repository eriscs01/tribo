import { forModule, type DB } from '@tribo/db';
import { ApiError, type RequestContext, type Tx, type WriteRecord } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { insertEvent, insertSnapshot, listChains, verifyChain, type EventRecord } from './repo.js';

export type { EventRecord } from './repo.js';

/**
 * The write path's last step: the aggregate's snapshot and its metadata-only event, in the
 * caller's transaction. A retired trip chain refuses the event (audit.chain_event), which
 * rolls the whole write back.
 */
export async function recordWrite(tx: Tx, ctx: RequestContext, record: WriteRecord): Promise<void> {
  const db = forModule(tx, 'audit');
  await insertSnapshot(db, record);
  try {
    await insertEvent(db, ctx, {
      action: record.action,
      entityType: record.aggregate,
      entityId: record.entityId,
      tripId: record.tripId,
      versionBefore: record.versionBefore,
      versionAfter: record.version,
      ...(record.restoredFrom === undefined ? {} : { restoredFrom: record.restoredFrom }),
    });
  } catch (error) {
    if (isConstraint(error, 'trip_retired')) throw new ApiError('trip_retired');
    throw error;
  }
}

function isConstraint(error: unknown, name: string): boolean {
  return error instanceof Error && 'constraint' in error && error.constraint === name;
}

/**
 * A credential act (sign-in, failed sign-in, sign-out): an event with no snapshot, since
 * credentials are never versioned. Auth actions route to the month's auth chain.
 */
export async function recordEvent(tx: Tx, ctx: RequestContext, event: EventRecord): Promise<void> {
  await insertEvent(forModule(tx, 'audit'), ctx, event);
}

export interface ChainReport {
  chainKey: string;
  events: number;
  headSeq: number;
  /** The first seq whose link or hash does not hold; null when the chain is intact. */
  brokenAt: number | null;
}

/**
 * `tribo audit verify`: walks every chain (or one) through audit.verify_chain, which
 * recomputes each hash from the canonical row, so a changed, removed or reordered event
 * shows as the first seq that no longer links.
 */
export async function verifyChains(db: Kysely<DB>, chainKey?: string): Promise<ChainReport[]> {
  const audit = forModule(db, 'audit');
  const reports: ChainReport[] = [];
  for (const chain of await listChains(audit, chainKey)) {
    reports.push({
      chainKey: chain.chain_key,
      events: Number(chain.events),
      headSeq: Number(chain.head_seq),
      // eslint-disable-next-line no-await-in-loop -- one chain at a time bounds the load a full audit puts on the database
      brokenAt: await verifyChain(audit, chain.chain_key),
    });
  }
  return reports;
}
