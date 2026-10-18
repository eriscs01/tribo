import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';
import type { RequestContext, WriteRecord } from '@tribo/platform';

/** The audit module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type AuditDb = ModuleDb<'audit'>;

export async function insertSnapshot(db: AuditDb, record: WriteRecord): Promise<void> {
  await db
    .insertInto('tribo.entity_versions')
    .values({
      entity_type: record.aggregate,
      entity_id: record.entityId,
      version: record.version,
      trip_id: record.tripId,
      snapshot: JSON.stringify(record.snapshot),
    })
    .execute();
}

/** One metadata-only audit event: a versioned write, or a credential act with no counter. */
export interface EventRecord {
  action: ValueOf<'audit.audit_events.action'>;
  entityType: string;
  /** null when the act names no row (a sign-in with an unknown username). */
  entityId: string | null;
  tripId: string | null;
  versionBefore?: number | null;
  versionAfter?: number | null;
  restoredFrom?: number;
}

/** The chain, seq, hashes and occurred_at are set by the insert trigger, never here. */
export async function insertEvent(
  db: AuditDb,
  ctx: RequestContext,
  record: EventRecord,
): Promise<void> {
  await db
    .insertInto('audit.audit_events')
    .values({
      actor_user_id: ctx.userId,
      actor_tz: ctx.actorTz ?? null,
      surface: ctx.surface,
      client_id: ctx.clientId ?? null,
      client_name: ctx.clientName ?? null,
      mcp_session: ctx.mcpSession ?? null,
      request_id: ctx.requestId,
      action: record.action,
      entity_type: record.entityType,
      entity_id: record.entityId,
      trip_id: record.tripId,
      version_before: record.versionBefore ?? null,
      version_after: record.versionAfter ?? null,
      restored_from: record.restoredFrom ?? null,
      // Placeholders the BEFORE INSERT trigger overwrites; the columns are NOT NULL.
      chain_key: '',
      seq: 0,
      prev_hash: Buffer.alloc(0),
      hash: Buffer.alloc(0),
    })
    .execute();
}

/** Every chain with its length and head seq, in key order; or just the one asked for. */
export function listChains(db: AuditDb, chainKey?: string) {
  let query = db
    .selectFrom('audit.audit_events')
    .select(['chain_key'])
    .select((eb) => [eb.fn.countAll<string>().as('events'), eb.fn.max('seq').as('head_seq')])
    .groupBy('chain_key')
    .orderBy('chain_key');
  if (chainKey !== undefined) query = query.where('chain_key', '=', chainKey);
  return query.execute();
}

/** audit.verify_chain: the first seq whose link or hash does not hold, or null when intact. */
export async function verifyChain(db: AuditDb, chainKey: string): Promise<number | null> {
  const { rows } = await sql<{ broken: string | null }>`
    SELECT audit.verify_chain(${chainKey}) AS broken`.execute(db);
  const broken = rows[0]?.broken ?? null;
  return broken === null ? null : Number(broken);
}
