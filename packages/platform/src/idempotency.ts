import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { forModule, type DB, type JsonValue } from '@tribo/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ApiError } from './errors.js';

/**
 * An Idempotency-Key a caller sent on an operation that honours it (decision 0017). The
 * adapter resolves it; the write path claims it inside the write's own transaction.
 */
export interface IdempotencyClaim {
  /** Who the key belongs to: 'user:<id>' (idempotency_keys.caller). */
  caller: string;
  key: string;
  operationId: string;
}

/** A stored response, sent again in place of running the operation. */
export class IdempotentReplay extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('idempotent replay');
  }
}

/** How long a second request waits for the first one's response to be stored. */
const RESPONSE_WAIT_MS = 2_000;
const RESPONSE_POLL_MS = 25;

/** JSON with object keys sorted, so a body's hash does not depend on key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** The SHA-256 that tells a repeat from a different request under the same key. */
export function requestHash(target: unknown, body: unknown): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ target, body: body ?? null })))
    .digest();
}

/**
 * Claims the key for this write, in its transaction. The insert waits while another
 * transaction holding the same key is in flight, so concurrent requests are serialised:
 * if that one commits, this one replays its response; if it rolls back, this one runs.
 * An expired key is deleted first and claimed afresh. Throws IdempotentReplay for a
 * repeat and idempotency_key_reused for another request under the same key.
 */
export async function claimKey(
  tx: Transaction<DB>,
  claim: IdempotencyClaim,
  hash: Buffer,
): Promise<void> {
  const db = forModule(tx, 'platform');
  await db
    .deleteFrom('tribo.idempotency_keys')
    .where('caller', '=', claim.caller)
    .where('key', '=', claim.key)
    .where('expires_at', '<=', sql<Date>`now()`)
    .execute();
  const claimed = await db
    .insertInto('tribo.idempotency_keys')
    .values({
      caller: claim.caller,
      key: claim.key,
      operation_id: claim.operationId,
      request_hash: hash,
    })
    .onConflict((oc) => oc.columns(['caller', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (claimed) return;

  const deadline = Date.now() + RESPONSE_WAIT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- waits for the first request's response
    const row = await db
      .selectFrom('tribo.idempotency_keys')
      .select(['operation_id', 'request_hash', 'response_status', 'response_body'])
      .where('caller', '=', claim.caller)
      .where('key', '=', claim.key)
      .executeTakeFirstOrThrow();
    if (row.operation_id !== claim.operationId || !row.request_hash.equals(hash)) {
      throw new ApiError('idempotency_key_reused');
    }
    if (row.response_status !== null) {
      throw new IdempotentReplay(row.response_status, row.response_body);
    }
    if (Date.now() >= deadline) {
      // The first request committed but its response was never stored (a crash between
      // commit and reply): what it answered cannot be replayed (runbook, Idempotency-Key).
      throw new Error(`${claim.operationId} committed under a key with no stored response`);
    }
    // eslint-disable-next-line no-await-in-loop -- one poll at a time
    await sleep(RESPONSE_POLL_MS);
  }
}

/** Where the adapter stores what a claimed request answered. */
export interface IdempotencyStore {
  /**
   * Stores the response of the request that claimed the key. Only a claim still waiting
   * for its response is updated, so a replay or a request that never reached the write
   * path stores nothing.
   */
  storeResponse(
    claim: IdempotencyClaim,
    response: { status: number; body: JsonValue; redacted: boolean },
  ): Promise<void>;
  /** Deletes the keys past their 24 hours (the daily job); resolves to how many. */
  deleteExpired(): Promise<number>;
}

export function createIdempotencyStore(db: Kysely<DB>): IdempotencyStore {
  const own = forModule(db, 'platform');
  return {
    storeResponse: async (claim, response) => {
      await own
        .updateTable('tribo.idempotency_keys')
        .set({
          response_status: response.status,
          response_body: JSON.stringify(response.body),
          response_redacted: response.redacted,
        })
        .where('caller', '=', claim.caller)
        .where('key', '=', claim.key)
        .where('operation_id', '=', claim.operationId)
        .where('response_status', 'is', null)
        .execute();
    },
    deleteExpired: async () => {
      const { numDeletedRows } = await own
        .deleteFrom('tribo.idempotency_keys')
        .where('expires_at', '<=', sql<Date>`now()`)
        .executeTakeFirst();
      return Number(numDeletedRows);
    },
  };
}
