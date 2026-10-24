import { forModule, type DB } from '@tribo/db';
import {
  ApiError,
  onConstraint,
  type RequestContext,
  type Tx,
  type WriteRecord,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import {
  deletedWithLatestDelete,
  deleteSnapshots,
  eventsOfRequest,
  insertEvent,
  insertSnapshot,
  listChains,
  verifyChain,
  type EventRecord,
} from './repo.js';

export type { EventRecord } from './repo.js';

/**
 * The write path's last step: the aggregate's snapshot and its metadata-only event, in the
 * caller's transaction. A retired trip chain refuses the event (audit.chain_event), which
 * rolls the whole write back.
 */
export async function recordWrite(tx: Tx, ctx: RequestContext, record: WriteRecord): Promise<void> {
  const db = forModule(tx, 'audit');
  await insertSnapshot(db, record);
  await recordEvent(tx, ctx, {
    action: record.action,
    entityType: record.aggregate,
    entityId: record.entityId,
    tripId: record.tripId,
    versionBefore: record.versionBefore,
    versionAfter: record.version,
    ...(record.restoredFrom === undefined ? {} : { restoredFrom: record.restoredFrom }),
  });
}

/**
 * An event with no snapshot: a credential act (sign-in, failed sign-in, sign-out), since
 * credentials are never versioned, or a reveal, which changes nothing. Auth actions route
 * to the month's auth chain. A retired trip chain refuses the event (trip_retired).
 */
export async function recordEvent(tx: Tx, ctx: RequestContext, event: EventRecord): Promise<void> {
  await insertEvent(forModule(tx, 'audit'), ctx, event).catch((error: unknown) =>
    onConstraint(error, { trip_retired: () => new ApiError('trip_retired') }),
  );
}

/**
 * A reveal (Technical design, "Reveal"): one event naming the field paths shown, never their
 * values, on the entity's chain, in the caller's transaction before the values are opened, so
 * a value that fails to open rolls its event back. Each call is its own; a reveal is never
 * replayed (R2). A retired trip chain refuses it (trip_retired).
 */
export function recordReveal(
  tx: Tx,
  ctx: RequestContext,
  reveal: {
    entityType: string;
    entityId: string;
    tripId: string | null;
    fields: readonly string[];
  },
): Promise<void> {
  return recordEvent(tx, ctx, {
    action: 'reveal',
    entityType: reveal.entityType,
    entityId: reveal.entityId,
    tripId: reveal.tripId,
    reason: reveal.fields.map((f) => `/${f}`).join(','),
  });
}

/**
 * Retention's step for one aggregate (Technical design, "Soft delete everywhere": hard
 * deletion "removes rows and snapshots"): drops every snapshot it has, in the caller's
 * transaction, before the purge records its tombstone with recordWrite.
 */
export async function dropSnapshots(tx: Tx, entityType: string, entityId: string): Promise<void> {
  await deleteSnapshots(forModule(tx, 'audit'), entityType, entityId);
}

/**
 * R32: the `entityType` rows deleted in the same request as the entity's latest delete,
 * found through the request id the log keeps (e.g. the private items a member's removal
 * soft-deleted, which their rejoin brings back). Ids only.
 */
export function deletedWithEntity(
  db: Kysely<DB>,
  of: { entityType: string; entityId: string },
  entityType: string,
): Promise<string[]> {
  return deletedWithLatestDelete(forModule(db, 'audit'), of, entityType);
}

/** One audit event as `tribo audit request` lists it: ids and metadata, never values. */
export interface RequestEvent {
  occurredAt: Date;
  chainKey: string;
  seq: number;
  action: string;
  entityType: string;
  entityId: string | null;
  versionAfter: number | null;
  surface: string;
  actorUserId: string | null;
}

/**
 * `tribo audit request <id>`: the events one request wrote, so its log lines (which carry
 * the same request id) and what it changed can be read side by side.
 */
export async function requestEvents(db: Kysely<DB>, requestId: string): Promise<RequestEvent[]> {
  const rows = await eventsOfRequest(forModule(db, 'audit'), requestId);
  return rows.map((row) => ({
    occurredAt: row.occurred_at,
    chainKey: row.chain_key,
    seq: Number(row.seq),
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    versionAfter: row.version_after,
    surface: row.surface,
    actorUserId: row.actor_user_id,
  }));
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
