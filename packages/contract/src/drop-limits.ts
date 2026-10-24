import type { Operation } from './operation.js';

/**
 * The Drop B limits (Operation inventory, "Drops"): what slice 1a ships narrower than the
 * registry entry describes. The OpenAPI document, the backlog and the scaffolded tests all read
 * them from here.
 */

/** The only creates that honour Idempotency-Key in 1a; the others the registry marks `key` follow in 1b. */
export const IDEMPOTENCY_KEY_OPERATIONS: readonly string[] = [
  'expenses.create',
  'files.upload',
  'tickets.create',
];

/** Writes that set an expense's amount and shares. */
export const EXPENSE_WRITES: readonly string[] = ['expenses.create', 'expenses.update'];

/** Whether the operation replays a repeated Idempotency-Key in this release. */
export function honoursIdempotencyKey(op: Pick<Operation, 'id' | 'idempotent'>): boolean {
  return op.idempotent === 'key' && IDEMPOTENCY_KEY_OPERATIONS.includes(op.id);
}

/**
 * The upload ceiling (Technical design, "Uploads and downloads"): 25 MB, the same as the
 * `tribo.files.size_bytes` CHECK. Caddy's request_body limit sits just above it, for the
 * multipart framing.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
